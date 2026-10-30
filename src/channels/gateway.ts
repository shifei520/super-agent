import { AssistantContent, ModelMessage } from "ai";
import { ToolRegistry } from "../tools/tool-registry";
import { ChannelDefinition, IncomingMessage } from "./types";
import { agentLoop, BudgetState } from "../agent/loop";

interface GatewayConfig {
  toolRegistry: ToolRegistry;
  model: any;
  buildSystem(): string;
  budget: BudgetState;
}

export class ChannelGateway {
  private config: GatewayConfig;
  private channels = new Map<string, ChannelDefinition>();
  private sessions = new Map<string, ModelMessage[]>();

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  register(channel: ChannelDefinition) {
    this.channels.set(channel.name, channel);
    channel.onMessage?.((msg) => {
      this.handleIncoming(channel.name, msg);
    });
  }

  private async handleIncoming(channelName: string, msg: IncomingMessage) {
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }

    const messages = this.sessions.get(sessionKey)!;
    const userMsg: ModelMessage = {
      role: "user",
      content: msg.text,
    };
    messages.push(userMsg);

    const system = this.config.buildSystem();
    await agentLoop(
      this.config.model,
      this.config.toolRegistry,
      messages,
      system,
      this.config.budget,
    );

    // 从 messages 里取最后一条 assistant 消息作为回复
    const lastMessage = messages[messages.length - 1];
    let replyText = "";
    if (lastMessage && lastMessage.role === "assistant") {
      const content: AssistantContent = lastMessage.content;
      if (typeof content === "string") {
        replyText = content;
      } else if (Array.isArray(content)) {
        replyText = content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }

    if (replyText) {
      const channel = this.channels.get(channelName);
      if (channel) {
        await channel.send({
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        });
      }
    }
  }

  async startAll() {
    for (const channel of this.channels.values()) {
      await channel.start();
    }
  }

  async stopAll() {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
  }
}
