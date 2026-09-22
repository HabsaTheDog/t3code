import { describe, expect, it } from "vite-plus/test";

import {
  INTERACTIVE_HTML_FILE_PREVIEW_SANDBOX,
  RESTRICTED_HTML_FILE_PREVIEW_SANDBOX,
} from "./filePreviewSandbox";

describe("HTML worksheet preview forms", () => {
  it.each([RESTRICTED_HTML_FILE_PREVIEW_SANDBOX, INTERACTIVE_HTML_FILE_PREVIEW_SANDBOX])(
    "runs local answer checking while blocking navigation (%s)",
    async (sandbox) => {
      const frame = document.createElement("iframe");
      frame.sandbox.value = sandbox;
      const messages: string[] = [];
      const receive = (event: MessageEvent) => {
        if (event.source === frame.contentWindow) messages.push(String(event.data));
      };
      window.addEventListener("message", receive);
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; form-action 'none'">
        <form id="answer"><input value="27"><button>Check</button></form>
        <form id="network" action="https://example.invalid/blocked"><button>Send</button></form>
        <script>
          document.getElementById('answer').onsubmit = (event) => {
            event.preventDefault(); parent.postMessage('answer-checked', '*');
          };
          document.addEventListener('securitypolicyviolation', (event) => {
            if (event.violatedDirective === 'form-action') parent.postMessage('network-blocked', '*');
          });
          document.querySelector('#answer button').click();
          document.querySelector('#network button').click();
        </script>`;
      document.body.append(frame);
      try {
        await expect.poll(() => messages).toContain("answer-checked");
        await expect.poll(() => messages).toContain("network-blocked");
      } finally {
        frame.remove();
        window.removeEventListener("message", receive);
      }
    },
  );
});
