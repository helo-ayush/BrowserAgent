import type { ManifestV3Export } from "@crxjs/vite-plugin";

const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: "AgentBrow",
  version: "0.1.0",
  description: "A visible, user-controlled browser agent.",
  icons: {
    "16": "icon16.png",
    "32": "icon32.png",
    "48": "icon48.png",
    "128": "icon128.png",
  },
  permissions: ["activeTab", "tabs", "storage", "sidePanel", "clipboardRead"],
  // The side panel can be opened without clicking the toolbar action, so
  // activeTab is not necessarily granted. captureVisibleTab therefore needs
  // an explicit all-sites host permission for this screenshot-first MVP.
  host_permissions: ["<all_urls>"],
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  action: {
    default_title: "Open AgentBrow",
    default_icon: {
      "16": "icon16.png",
      "32": "icon32.png",
      "48": "icon48.png",
      "128": "icon128.png",
    },
  },
  side_panel: { default_path: "src/sidepanel/index.html" },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/agent-bridge.ts"],
      run_at: "document_idle",
    },
  ],
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; connect-src http://localhost:8787",
  },
};

export default manifest;
