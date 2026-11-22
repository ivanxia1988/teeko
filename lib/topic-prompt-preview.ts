export type TopicPromptPreview = {
  registrationJson: string;
  voiceModel: string;
  activities: Array<{
    id: string;
    label: string;
    instructions: string;
    opening: string;
    backendInstructions?: string;
    contextUpdate?: string;
    advance?: string;
  }>;
  silenceCue: string;
};
