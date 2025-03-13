/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { TerminalCapability, type ITerminalCommand } from '../../../platform/terminal/common/capabilities/capabilities.js';
import { ExtHostContext, MainContext, type ExtHostTerminalShellIntegrationShape, type MainThreadTerminalShellIntegrationShape } from '../common/extHost.protocol.js';
import { ITerminalService } from '../../contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { extHostNamedCustomer, type IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { TerminalShellExecutionCommandLineConfidence } from '../common/extHostTypes.js';

@extHostNamedCustomer(MainContext.MainThreadTerminalShellIntegration)
export class MainThreadTerminalShellIntegration extends Disposable implements MainThreadTerminalShellIntegrationShape {
	private readonly _proxy: ExtHostTerminalShellIntegrationShape;

	constructor(
		extHostContext: IExtHostContext,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkbenchEnvironmentService workbenchEnvironmentService: IWorkbenchEnvironmentService
	) {
		super();

		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostTerminalShellIntegration);

		const instanceDataListeners: Map<number, IDisposable> = new Map();
		this._register(toDisposable(() => {
			for (const listener of instanceDataListeners.values()) {
				listener.dispose();
			}
		}));

		// onDidChangeTerminalShellIntegration initial state
		for (const terminal of this._terminalService.instances) {
			const cmdDetection = terminal.capabilities.get(TerminalCapability.CommandDetection);
			if (cmdDetection?.hasRichCommandDetection) {
				this._proxy.$shellIntegrationChange(terminal.instanceId);
			}
			const cwdDetection = terminal.capabilities.get(TerminalCapability.CwdDetection);
			if (cwdDetection) {
				this._proxy.$cwdChange(terminal.instanceId, this._convertCwdToUri(cwdDetection.getCwd()));
			}
		}

		// onDidChangeTerminalShellIntegration via rich command detection
		const onDidSetRichCommandDetection = this._store.add(this._terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, e => e.onSetRichCommandDetection));
		this._store.add(onDidSetRichCommandDetection.event(e => {
			this._proxy.$shellIntegrationChange(e.instance.instanceId);
		}));

		// onDidChangeTerminalShellIntegration via cwd
		const cwdChangeEvent = this._store.add(this._terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CwdDetection, e => e.onDidChangeCwd));
		this._store.add(cwdChangeEvent.event(e => {
			this._proxy.$cwdChange(e.instance.instanceId, this._convertCwdToUri(e.data));
		}));

		// onDidChangeTerminalShellIntegration via env
		const envChangeEvent = this._store.add(this._terminalService.createOnInstanceCapabilityEvent(TerminalCapability.ShellEnvDetection, e => e.onDidChangeEnv));
		this._store.add(envChangeEvent.event(e => {
			if (e.data.value && typeof e.data.value === 'object') {
				const envValue = e.data.value as { [key: string]: string | undefined };

				// Extract keys and values
				const keysArr = Object.keys(envValue);
				const valuesArr = Object.values(envValue);
				this._proxy.$shellEnvChange(e.instance.instanceId, keysArr, valuesArr as string[], e.data.isTrusted);
			}
		}));

		// onDidStartTerminalShellExecution
		const commandDetectionStartEvent = this._store.add(this._terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, e => e.onCommandExecuted));
		let currentCommand: ITerminalCommand | undefined;
		this._store.add(commandDetectionStartEvent.event(e => {
			// Prevent duplicate events from being sent in case command detection double fires the
			// event
			if (e.data === currentCommand) {
				return;
			}
			// String paths are not exposed in the extension API
			currentCommand = e.data;
			const instanceId = e.instance.instanceId;
			this._proxy.$shellExecutionStart(instanceId, e.data.command, convertToExtHostCommandLineConfidence(e.data), e.data.isTrusted, this._convertCwdToUri(e.data.cwd));

			// TerminalShellExecution.createDataStream
			// Debounce events to reduce the message count - when this listener is disposed the events will be flushed
			instanceDataListeners.get(instanceId)?.dispose();
			instanceDataListeners.set(instanceId, Event.accumulate(e.instance.onData, 50, this._store)(events => {
				this._proxy.$shellExecutionData(instanceId, events.join(''));
			}));
		}));

		// onDidEndTerminalShellExecution
		const commandDetectionEndEvent = this._store.add(this._terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, e => e.onCommandFinished));
		this._store.add(commandDetectionEndEvent.event(e => {
			currentCommand = undefined;
			const instanceId = e.instance.instanceId;
			instanceDataListeners.get(instanceId)?.dispose();
			// Shell integration C (executed) and D (command finished) sequences should always be in
			// their own events, so send this immediately. This means that the D sequence will not
			// be included as it's currently being parsed when the command finished event fires.
			this._proxy.$shellExecutionEnd(instanceId, e.data.command, convertToExtHostCommandLineConfidence(e.data), e.data.isTrusted, e.data.exitCode);
		}));

		// Clean up after dispose
		this._store.add(this._terminalService.onDidDisposeInstance(e => this._proxy.$closeTerminal(e.instanceId)));
	}

	$executeCommand(terminalId: number, commandLine: string): void {
		this._terminalService.getInstanceFromId(terminalId)?.runCommand(commandLine, true);
	}

	private _convertCwdToUri(cwd: string | undefined): URI | undefined {
		return cwd ? URI.file(cwd) : undefined;
	}
}

function convertToExtHostCommandLineConfidence(command: ITerminalCommand): TerminalShellExecutionCommandLineConfidence {
	switch (command.commandLineConfidence) {
		case 'high':
			return TerminalShellExecutionCommandLineConfidence.High;
		case 'medium':
			return TerminalShellExecutionCommandLineConfidence.Medium;
		case 'low':
		default:
			return TerminalShellExecutionCommandLineConfidence.Low;
	}
}
