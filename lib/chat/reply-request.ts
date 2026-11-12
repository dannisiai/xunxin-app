export type ChatReplyRequestOptions = {
    signal?: AbortSignal;
    requiredVisionMessageId?: string;
};

export type ChatReplyRequestDetail = ChatReplyRequestOptions & {
    sessionId?: string;
    characterId?: string;
    handled?: boolean;
    busy?: boolean;
    completion?: Promise<void>;
};
