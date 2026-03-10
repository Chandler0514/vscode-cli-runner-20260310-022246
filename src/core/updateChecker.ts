import * as vscode from 'vscode';
import { readIntegrationConfig } from './config';

const LAST_CHECK_KEY = 'cliRunner.update.lastCheckMs';
const LAST_SHOWN_VERSION_KEY = 'cliRunner.update.lastShownVersion';
const SKIP_VERSION_KEY = 'cliRunner.update.skipVersion';

interface UpdateFeedInfo {
  readonly version: string;
  readonly url: string;
}

export class UpdateChecker {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  public async maybeCheckOnStartup(): Promise<void> {
    const config = readIntegrationConfig().update;
    if (!config.enabled || !config.feedUrl) {
      return;
    }

    const lastCheck = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
    const elapsedMs = Date.now() - lastCheck;
    const intervalMs = Math.max(1, config.intervalHours) * 60 * 60 * 1000;
    if (elapsedMs < intervalMs) {
      return;
    }

    await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
    await this.check(false);
  }

  public async check(interactive: boolean): Promise<void> {
    const config = readIntegrationConfig().update;
    if (!config.enabled || !config.feedUrl) {
      if (interactive) {
        vscode.window.showWarningMessage('Update check is disabled or update feed URL is empty.');
      }
      return;
    }

    const feed = await fetchLatestVersion(config.feedUrl, this.output);
    if (!feed) {
      if (interactive) {
        vscode.window.showWarningMessage('Failed to check updates. Check network or update feed URL.');
      }
      return;
    }

    const currentVersion = normalizeVersion(this.context.extension.packageJSON.version ?? '0.0.0');
    if (compareVersions(feed.version, currentVersion) <= 0) {
      if (interactive) {
        vscode.window.showInformationMessage(`CLI Runner is up to date (v${currentVersion}).`);
      }
      return;
    }

    const skipped = this.context.globalState.get<string>(SKIP_VERSION_KEY, '');
    if (!interactive && skipped === feed.version) {
      return;
    }

    const lastShown = this.context.globalState.get<string>(LAST_SHOWN_VERSION_KEY, '');
    if (!interactive && lastShown === feed.version) {
      return;
    }
    await this.context.globalState.update(LAST_SHOWN_VERSION_KEY, feed.version);

    const openRelease = 'Open Release';
    const openExtensions = 'Open Extensions';
    const skipVersion = 'Skip This Version';
    const message = `Update available: CLI Runner v${feed.version} (current v${currentVersion}).`;
    const picked = await vscode.window.showInformationMessage(
      message,
      openRelease,
      openExtensions,
      skipVersion
    );

    if (picked === openRelease) {
      await vscode.env.openExternal(vscode.Uri.parse(feed.url));
      return;
    }
    if (picked === openExtensions) {
      const id = `${this.context.extension.packageJSON.publisher}.${this.context.extension.packageJSON.name}`;
      await vscode.commands.executeCommand('workbench.extensions.search', `@id:${id}`);
      return;
    }
    if (picked === skipVersion) {
      await this.context.globalState.update(SKIP_VERSION_KEY, feed.version);
    }
  }
}

async function fetchLatestVersion(feedUrl: string, output: vscode.OutputChannel): Promise<UpdateFeedInfo | undefined> {
  try {
    const response = await fetch(feedUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'cli-runner-sidebar'
      }
    });
    if (!response.ok) {
      output.appendLine(`[update] Feed request failed: ${response.status} ${response.statusText}`);
      return undefined;
    }
    const payload = await response.json() as Record<string, unknown>;

    const tag = typeof payload.tag_name === 'string'
      ? payload.tag_name
      : (typeof payload.version === 'string' ? payload.version : '');
    const version = normalizeVersion(tag);
    if (!version) {
      output.appendLine('[update] Feed did not return tag_name/version.');
      return undefined;
    }
    const url = typeof payload.html_url === 'string'
      ? payload.html_url
      : (typeof payload.url === 'string' ? payload.url : feedUrl);

    return { version, url };
  } catch (error) {
    output.appendLine(`[update] Check failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function normalizeVersion(input: string): string {
  const sanitized = input.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(sanitized);
  if (!match) {
    return '';
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((item) => Number.parseInt(item, 10));
  const pb = b.split('.').map((item) => Number.parseInt(item, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
