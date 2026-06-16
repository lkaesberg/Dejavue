import { dejavueCommand } from './dejavue';
import { markAnswerCommand } from './markAnswer';
import type { MessageContextCommand, SlashCommand } from './types';

export const slashCommands: SlashCommand[] = [dejavueCommand];
export const contextCommands: MessageContextCommand[] = [markAnswerCommand];

export const slashByName = new Map(slashCommands.map((c) => [c.data.name, c]));
export const contextByName = new Map(contextCommands.map((c) => [c.data.name, c]));

/** All command payloads for REST registration. */
export function allCommandJSON() {
  return [
    ...slashCommands.map((c) => c.data.toJSON()),
    ...contextCommands.map((c) => c.data.toJSON()),
  ];
}
