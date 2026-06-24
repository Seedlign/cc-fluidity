import * as vscode from 'vscode';
import { UsageTracker } from './usageTracker';
import { FluidView, FluidPanel } from './fluidView';

export function activate(ctx: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('claudeUsage');
  const dir = cfg.get<string>('projectsDir') || UsageTracker.defaultDir();

  const tracker = new UsageTracker(dir);
  const view = new FluidView(tracker, ctx);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FluidView.viewId, view),
    vscode.commands.registerCommand('claudeUsage.openPanel', () => FluidPanel.createOrShow(tracker, ctx)),
    { dispose: () => tracker.stop() },
  );

  tracker.start();
}

export function deactivate() {}
