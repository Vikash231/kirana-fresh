import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Thin wrapper: call a merchant MCP tool and get its JSON payload back. */
export class MerchantClient {
  private constructor(private readonly client: Client) {}

  static async connect(command: string, args: string[]): Promise<MerchantClient> {
    const client = new Client({ name: "agentic-commerce-buyer", version: "0.1.0" });
    // The MCP SDK forwards only HOME/PATH/SHELL/TERM/USER/LOGNAME to a spawned
    // server — a good default, and the reason an earlier live run silently fell
    // back to the fake gateway. Forward the merchant's Razorpay credentials
    // explicitly, and nothing else: the merchant has no use for an LLM key.
    const inherited = Object.fromEntries(
      ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]
        .map((k) => [k, process.env[k]])
        .filter((e): e is [string, string] => e[1] !== undefined),
    );
    await client.connect(new StdioClientTransport({ command, args, env: inherited, stderr: "pipe" }));
    return new MerchantClient(client);
  }

  async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "{}";
    return JSON.parse(text) as T;
  }

  async listTools(): Promise<string[]> {
    const res = await this.client.listTools();
    return res.tools.map((t) => t.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
