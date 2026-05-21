import { getDeepSeekBaseUrl } from "../config";
import { OpenAICompatibleProvider } from "./openaiCompatible";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  public constructor(apiKeyProvider: () => Promise<string | undefined>) {
    super({
      id: "deepseek",
      name: "DeepSeek",
      baseUrlProvider: getDeepSeekBaseUrl,
      apiKeyProvider,
      requireApiKey: true
    });
  }
}
