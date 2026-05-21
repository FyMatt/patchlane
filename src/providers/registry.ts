import { getActiveModel } from "../config";
import { LLMProvider } from "./types";

export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  public register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  public get(providerId: string): LLMProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`LLM provider is not registered: ${providerId}`);
    }

    return provider;
  }

  public getActiveProvider(): LLMProvider {
    return this.get(getActiveModel().providerId);
  }
}

