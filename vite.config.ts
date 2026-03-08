import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8790";
const wsTarget = process.env.VITE_WS_PROXY_TARGET ?? apiTarget.replace(/^http/i, "ws");

type ProxyErrorResponse = ServerResponse<IncomingMessage> | Socket;
type ProxyLike = {
  on(
    event: "error",
    listener: (err: NodeJS.ErrnoException, req: IncomingMessage, res: ProxyErrorResponse) => void,
  ): void;
  on(event: "proxyReqWs", listener: (proxyReq: unknown, req: IncomingMessage, socket: Socket) => void): void;
};

const isServerResponse = (res: ProxyErrorResponse): res is ServerResponse<IncomingMessage> => {
  return typeof (res as ServerResponse<IncomingMessage>).writeHead === "function";
};

const silenceEpipe = (proxy: ProxyLike) => {
  proxy.on("error", (err: NodeJS.ErrnoException, _req, res) => {
    if (err.code === "EPIPE" || err.code === "ECONNRESET") return;
    if (res && isServerResponse(res) && !res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });
  proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ECONNRESET") return;
    });
  });
};

const SOURCE_CHUNK_RULES: Array<{ chunkName: string; patterns: string[] }> = [
  {
    chunkName: "office-view",
    patterns: ["/src/components/OfficeView.tsx", "/src/components/office-view/"],
  },
  {
    chunkName: "taskboard",
    patterns: ["/src/components/TaskBoard.tsx", "/src/components/taskboard/"],
  },
  {
    chunkName: "agent-manager",
    patterns: ["/src/components/AgentManager.tsx", "/src/components/agent-manager/"],
  },
  {
    chunkName: "settings-panel",
    patterns: ["/src/components/SettingsPanel.tsx", "/src/components/settings/"],
  },
  {
    chunkName: "skills-library",
    patterns: ["/src/components/SkillsLibrary.tsx", "/src/components/skills-library/"],
  },
  {
    chunkName: "chat-panel",
    patterns: ["/src/components/ChatPanel.tsx", "/src/components/chat-panel/"],
  },
  {
    chunkName: "dashboard",
    patterns: ["/src/components/Dashboard.tsx", "/src/components/dashboard/"],
  },
  {
    chunkName: "terminal-panel",
    patterns: ["/src/components/TerminalPanel.tsx", "/src/components/terminal-panel/"],
  },
];

const manualChunks = (id: string): string | undefined => {
  const normalizedId = id.replace(/\\/g, "/");

  for (const rule of SOURCE_CHUNK_RULES) {
    if (rule.patterns.some((pattern) => normalizedId.includes(pattern))) {
      return rule.chunkName;
    }
  }

  if (!normalizedId.includes("node_modules")) return undefined;
  if (normalizedId.includes("/node_modules/@pixi/")) {
    const match = normalizedId.match(/\/node_modules\/(@pixi\/[^/]+)\//);
    if (match) return `vendor-${match[1].replace("@pixi/", "pixi-")}`;
  }
  if (normalizedId.includes("/node_modules/pixi.js/")) return "vendor-pixi";
  if (normalizedId.includes("/node_modules/pptxgenjs/")) return "vendor-pptx";
  if (normalizedId.includes("/node_modules/react-router-dom/") || normalizedId.includes("/node_modules/react-router/"))
    return "vendor-router";
  if (
    normalizedId.includes("/node_modules/react-dom/") ||
    normalizedId.includes("/node_modules/react/") ||
    normalizedId.includes("/node_modules/scheduler/")
  )
    return "vendor-react";
  return undefined;
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts: [".ts.net"],
    watch: {
      ignored: ["**/.climpire-worktrees/**"],
    },
    proxy: {
      "/api": {
        target: apiTarget,
        configure: silenceEpipe,
      },
      "/ws": {
        target: wsTarget,
        ws: true,
        configure: silenceEpipe,
      },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
