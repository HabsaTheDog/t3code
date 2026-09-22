import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("shows a model only once when built-in and custom entries overlap", () => {
    const model = {
      slug: "shared-model",
      name: "Shared model",
      isCustom: false,
      capabilities: null,
    };
    const models = deriveProviderModelsForDisplay({
      liveModels: [model, model],
      customModels: ["shared-model", "custom-model", "custom-model"],
    });
    expect(models.map((model) => model.slug)).toEqual(["shared-model", "custom-model"]);
    expect(models[0]?.name).toBe("Shared model");
  });

  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});
