import 'dotenv/config';
import { generateText, streamText } from 'ai';
import type { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai';
import { createInterface } from 'node:readline';

const ds = createOpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = ds.chat('deepseek-flash')

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
})

const messages: ModelMessage[] = []

async function main() {
  rl.question('请输入你的问题：', async (q: string) => {
    const trimedQuery = q.trim();
    if (!trimedQuery || trimedQuery === 'exit') {
        console.log('Bye!');
        rl.close();
        return;
    }

    messages.push({
        role: 'user',
        content: trimedQuery,
    })

    let fullResponse = '';

    const result = await streamText({
        model,
        system: `你是 Super Agent，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`,
        messages,
    });

    for await (const chunk of result.textStream) {
        process.stdout.write(chunk);
        fullResponse += chunk;
    }

    console.log();

    messages.push({
        role: 'assistant',
        content: fullResponse,
    })

    main()
  })
}

main();