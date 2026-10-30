import { ChannelDefinition, IncomingMessage, OutgoingMessage } from "./types";
import * as lark from "@larksuiteoapi/node-sdk";

interface FeiShuConfig {
  appId: string;
  appSecret: string;
}

export class FeiShuChannel implements ChannelDefinition {
  name = "feishu";
  description = "飞书 Bot 消息通道（长连接模式）";
  private config: FeiShuConfig;
  private onMessageHandler?: (msg: IncomingMessage) => void;
  private larkClient: any;
  private wsClient: any;

  constructor(config: FeiShuConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.onMessageHandler = handler;
  }

  async start() {
    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });
    const eventDispatcher = new lark.EventDispatcher({}).register({
      // 处理「接收消息」事件，事件类型为 im.message.receive_v1
      "im.message.receive_v1": async (data) => {
        const { message, sender } = data;
        // 在此处理您的业务逻辑，例如回复消息
        if (message.message_type !== "text") return;

        let text = message.content || "";
        if (message.mentions) {
          for (const mention of message.mentions) {
            text = text.replace(mention.key, "").trim();
          }
        }
        if (text && this.onMessageHandler) {
          this.onMessageHandler({
            channelId: message.chat_id,
            senderId: sender.sender_id?.open_id ?? "",
            senderName: sender.sender_id?.open_id ?? "",
            text,
            raw: data,
          });
        }
      },
    });
    await this.wsClient.start({
      eventDispatcher,
    });
  }

  stop(): void {}

  async send(msg: OutgoingMessage): Promise<void> {
    // 通过 Client 调用「发送消息」给飞书
    await this.larkClient.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: msg.channelId,
        content: JSON.stringify({ text: msg.text }),
        msg_type: "text",
      },
    });
  }
}
