// Transcript (3), textarea (1), prompt chrome (5), Surface padding/gap (2).
export const MIN_CONVERSATION_HEIGHT = 11

export function conversationPromptHeight(height: number, preferred: number) {
  return Math.max(1, Math.min(preferred, height - (MIN_CONVERSATION_HEIGHT - 1)))
}
