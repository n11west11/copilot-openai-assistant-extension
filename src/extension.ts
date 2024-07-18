import * as vscode from 'vscode';
import OpenAI from "openai";
import { EventEmitter } from 'events';
import { AssistantStreamEvent } from 'openai/src/resources/beta/index.js';
import { Run } from 'openai/src/resources/beta/threads/index.js';


class EventHandler extends EventEmitter {
  client: OpenAI;
  stream: vscode.ChatResponseStream;
  streamClosed: boolean | undefined;

  constructor(client: OpenAI, stream: vscode.ChatResponseStream) {
    super();
    this.client = client;
    this.stream = stream;
  }

  async onEvent(event: AssistantStreamEvent) {
    try {
      console.log(event);
      // Retrieve events that are denoted with 'requires_action'
      // since these will have our tool_calls

      if (event.event === "thread.message.delta" && event.data.delta.content) {
        this.stream.markdown(event.data.delta.content[0].text.value);
      }
      if (event.event === "thread.run.requires_action") {
        this.stream.progress("Processing required action...");
        await this.handleRequiresAction(
          event.data,
          event.data.id,
          event.data.thread_id,
        );
      }
    } catch (error) {
      console.error("Error handling event:", error);
    }
  }

  async handleRequiresAction(data: Run, runId: string, threadId: string) {
    try {
      const toolOutputs = [];
      for (const toolCall of data.required_action?.submit_tool_outputs?.tool_calls ?? []) {
        if (toolCall.function.name === "getCurrentTemperature") {
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: "57",
          });
        } else if (toolCall.function.name === "addMemory") {
          const args = JSON.parse(toolCall.function.arguments);
          const result = await addMemory(
            args.fileName,
            args.extension,
            args.fileContent,
          );
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: result,
          });
        } else if (toolCall.function.name === "getRainProbability") {
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: "0.06",
          });
        }
      }
      // Submit all the tool outputs at the same time and return the stream
      await this.submitToolOutputs(toolOutputs, runId, threadId);
    } catch (error) {
      console.error("Error processing required action:", error);
      throw error;
    }
  }

  async submitToolOutputs(toolOutputs: { tool_call_id: string; output: string; }[], runId: string, threadId: string) {
    try {
      // Use the submitToolOutputsStream helper
      const stream = this.client.beta.threads.runs.submitToolOutputsStream(
        threadId,
        runId,
        { tool_outputs: toolOutputs },
      );
      for await (const event of stream) {
        this.emit("event", event);
      }
    } catch (error) {
      console.error("Error submitting tool outputs:", error);
    }
  }

  closeStream() {
    this.streamClosed = true;
  }
}


export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, responseStream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> => {
    const apiKey: string = vscode.workspace.getConfiguration('openai').get('apiKey') || process.env.OPENAI_API_KEY || "";
    
    if (!apiKey) {
      responseStream.markdown("Please set your OpenAI API key in the extension settings, and restart the chat.");
      return;
    }

    const openai = new OpenAI({
      apiKey: apiKey,
    });

    const assistant_id: string = vscode.workspace.getConfiguration('openai').get('assistantId') || "";
    if (!assistant_id) {
      responseStream.markdown("Please set your OpenAI assistant ID in the extension settings, and restart the chat.");
      return;
    }

    const assistant = await openai.beta.assistants.retrieve(assistant_id);

    await openai.beta.assistants.update(assistant.id, {
      tools: [
        {
          "type": "code_interpreter",
        },
        {
          "type": "file_search"
        }
      ]
    });

    const userQuery = request.prompt;

    const messages = context.history.map((item: any) => {
      switch (item.constructor) {
        case vscode.ChatRequestTurn:
          return {
            role: "user",
            content: item.prompt,
          };
        case vscode.ChatResponseTurn:
          const markdownContents = item.response
            .filter((part: any) => part instanceof vscode.ChatResponseMarkdownPart)
            .map((markdownPart: { value: { value: any; }; }) => markdownPart.value.value)
            .join(' ');
          return {
            role: "assistant",
            content: markdownContents || " ",
          };
        default:
          return null;
      }
    }).filter(item => item !== null);

    messages.push({
      role: "user",
      content: "The users active window currently shows the following:\n" + vscode.window.activeTextEditor?.document.getText() || "Nothing is displayed in the active window.",
    });

    const thread = await openai.beta.threads.create({
      messages: messages.slice(0, 30),
    });

    for (let i = 0; i < messages.length; i++)   {
      const message = await openai.beta.threads.messages.create(
        thread.id,
        {
          role: messages[i].role,
          content: messages[i].content,
        }
      );
    }

    const message = await openai.beta.threads.messages.create(
      thread.id,
      {
        role: "user",
        content: userQuery,
      }
    );

    // let child_streams = [];
    const eventHandler = new EventHandler(openai, responseStream);
    eventHandler.on("event", eventHandler.onEvent.bind(eventHandler));

    const stream = await openai.beta.threads.runs.stream(
      thread.id,
      { assistant_id: assistant.id },
    );
    let run = null;

    
    for await (const event of stream) {
      if (event.event === "thread.run.created") {
        run = event.data;
      }
      eventHandler.emit("event", event);
    }

    while(run?.status !== "completed") {
      run = await openai.beta.threads.runs.retrieve(thread.id, run?.id || "");
      console.log("Waiting for run to complete %s", run.status);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

  }

  const chat = vscode.chat.createChatParticipant("opeanai.assistant", handler);
};


export function deactivate() { }

module.exports = {
  activate,
  deactivate
};