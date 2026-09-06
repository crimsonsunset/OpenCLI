/**
 * Local augmentation for chrome.userScripts.execute — locked @types/chrome
 * 0.0.287 predates this MV3 API surface.
 */
declare namespace chrome.userScripts {
  type World = 'USER_SCRIPT' | 'MAIN';

  interface InjectionResult {
    documentId?: string;
    frameId?: number;
    result?: unknown;
    error?: unknown;
  }

  interface InjectionTarget {
    tabId: number;
    frameIds?: number[];
    documentIds?: string[];
    allFrames?: boolean;
  }

  interface ScriptSource {
    code?: string;
    file?: string;
  }

  interface UserScriptInjection {
    target: InjectionTarget;
    js: ScriptSource[];
    world?: World;
    injectImmediately?: boolean;
  }

  /**
   * Execute an ephemeral user script in the given world.
   * @param injection - Target + script sources
   */
  function execute(injection: UserScriptInjection): Promise<InjectionResult[]>;
}

interface ChromeUserScriptsNamespace {
  execute: typeof chrome.userScripts.execute;
}

interface Chrome {
  userScripts?: ChromeUserScriptsNamespace;
}
