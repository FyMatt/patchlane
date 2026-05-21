import * as vscode from "vscode";

const DEEPSEEK_API_KEY = "codeAgent.deepseek.apiKey";
const PROVIDER_API_KEY_PREFIX = "codeAgent.provider.";
const WEB_SEARCH_API_KEY = "codeAgent.webSearch.apiKey";

export class SecretService {
  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public getDeepSeekApiKey(): Thenable<string | undefined> {
    return this.secrets.get(DEEPSEEK_API_KEY);
  }

  public setDeepSeekApiKey(apiKey: string): Thenable<void> {
    return this.secrets.store(DEEPSEEK_API_KEY, apiKey);
  }

  public getProviderApiKey(providerId: string): Thenable<string | undefined> {
    return this.secrets.get(`${PROVIDER_API_KEY_PREFIX}${providerId}.apiKey`);
  }

  public setProviderApiKey(providerId: string, apiKey: string): Thenable<void> {
    return this.secrets.store(`${PROVIDER_API_KEY_PREFIX}${providerId}.apiKey`, apiKey);
  }

  public getWebSearchApiKey(): Thenable<string | undefined> {
    return this.secrets.get(WEB_SEARCH_API_KEY);
  }

  public setWebSearchApiKey(apiKey: string): Thenable<void> {
    return this.secrets.store(WEB_SEARCH_API_KEY, apiKey);
  }
}
