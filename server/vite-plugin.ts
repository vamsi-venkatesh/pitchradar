import type { Plugin } from "vite";
import { handleAgentApi } from "./http";

export function pitchRadarApiPlugin(): Plugin {
  return {
    name: "pitchradar-agent-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (await handleAgentApi(request, response)) return;
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (await handleAgentApi(request, response)) return;
        next();
      });
    }
  };
}

