import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import {
  _moveMouseTool,
  _traceMouseTool,
  _clickMouseTool,
  _pressMouseTool,
  _dragMouseTool,
  _scrollTool,
  _typeKeysTool,
  _pressKeysTool,
  _typeTextTool,
  _waitTool,
  _screenshotTool,
  _cursorPositionTool,
  _setTaskStatusTool,
  _createTaskTool,
} from '../agent/agent.tools';

function agentToolToOpenAITool(agentTool: any): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: agentTool.name,
      description: agentTool.description,
      parameters: agentTool.input_schema,
    },
  } as ChatCompletionTool;
}

export const moveMouseTool: ChatCompletionTool =
  agentToolToOpenAITool(_moveMouseTool);
export const traceMouseTool: ChatCompletionTool =
  agentToolToOpenAITool(_traceMouseTool);
export const clickMouseTool: ChatCompletionTool =
  agentToolToOpenAITool(_clickMouseTool);
export const pressMouseTool: ChatCompletionTool =
  agentToolToOpenAITool(_pressMouseTool);
export const dragMouseTool: ChatCompletionTool =
  agentToolToOpenAITool(_dragMouseTool);
export const scrollTool: ChatCompletionTool =
  agentToolToOpenAITool(_scrollTool);
export const typeKeysTool: ChatCompletionTool =
  agentToolToOpenAITool(_typeKeysTool);
export const pressKeysTool: ChatCompletionTool =
  agentToolToOpenAITool(_pressKeysTool);
export const typeTextTool: ChatCompletionTool =
  agentToolToOpenAITool(_typeTextTool);
export const waitTool: ChatCompletionTool = agentToolToOpenAITool(_waitTool);
export const screenshotTool: ChatCompletionTool =
  agentToolToOpenAITool(_screenshotTool);
export const cursorPositionTool: ChatCompletionTool =
  agentToolToOpenAITool(_cursorPositionTool);
export const setTaskStatusTool: ChatCompletionTool =
  agentToolToOpenAITool(_setTaskStatusTool);
export const createTaskTool: ChatCompletionTool =
  agentToolToOpenAITool(_createTaskTool);

export const openaiTools: ChatCompletionTool[] = [
  moveMouseTool,
  traceMouseTool,
  clickMouseTool,
  pressMouseTool,
  dragMouseTool,
  scrollTool,
  typeKeysTool,
  pressKeysTool,
  typeTextTool,
  screenshotTool,
  cursorPositionTool,
  setTaskStatusTool,
  createTaskTool,
];
