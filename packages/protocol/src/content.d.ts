import { z } from "zod";
/**
 * Anthropic-Messages content blocks. This is yodex's internal canonical message
 * format — the gateway translates these to/from each provider, so the engine only
 * ever speaks this one shape. See docs/02 and docs/03.
 */
export declare const cacheControlSchema: z.ZodObject<{
    type: z.ZodLiteral<"ephemeral">;
}, "strip", z.ZodTypeAny, {
    type: "ephemeral";
}, {
    type: "ephemeral";
}>;
export type CacheControl = z.infer<typeof cacheControlSchema>;
export declare const textBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    cache_control: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"ephemeral">;
    }, "strip", z.ZodTypeAny, {
        type: "ephemeral";
    }, {
        type: "ephemeral";
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}>;
export type TextBlock = z.infer<typeof textBlockSchema>;
export declare const thinkingBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"thinking">;
    thinking: z.ZodString;
    signature: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "thinking";
    thinking: string;
    signature?: string | undefined;
}, {
    type: "thinking";
    thinking: string;
    signature?: string | undefined;
}>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export declare const toolUseBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    id: z.ZodString;
    name: z.ZodString;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}, {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export declare const imageBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"image">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
/** Documents (e.g. PDFs) the model can read natively. */
export declare const documentBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"document">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>;
export type DocumentBlock = z.infer<typeof documentBlockSchema>;
/** tool_result content can be a plain string or a list of text/image/document blocks. */
export declare const toolResultBlocksSchema: z.ZodArray<z.ZodUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    cache_control: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"ephemeral">;
    }, "strip", z.ZodTypeAny, {
        type: "ephemeral";
    }, {
        type: "ephemeral";
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"document">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>]>, "many">;
export type ToolResultBlocks = z.infer<typeof toolResultBlocksSchema>;
export declare const toolResultContentSchema: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    cache_control: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"ephemeral">;
    }, "strip", z.ZodTypeAny, {
        type: "ephemeral";
    }, {
        type: "ephemeral";
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"document">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>]>, "many">]>;
export declare const toolResultBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    tool_use_id: z.ZodString;
    content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        cache_control: z.ZodOptional<z.ZodObject<{
            type: z.ZodLiteral<"ephemeral">;
        }, "strip", z.ZodTypeAny, {
            type: "ephemeral";
        }, {
            type: "ephemeral";
        }>>;
    }, "strip", z.ZodTypeAny, {
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    }, {
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        source: z.ZodObject<{
            type: z.ZodLiteral<"base64">;
            media_type: z.ZodString;
            data: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "base64";
            media_type: string;
            data: string;
        }, {
            type: "base64";
            media_type: string;
            data: string;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }, {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }>, z.ZodObject<{
        type: z.ZodLiteral<"document">;
        source: z.ZodObject<{
            type: z.ZodLiteral<"base64">;
            media_type: z.ZodString;
            data: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "base64";
            media_type: string;
            data: string;
        }, {
            type: "base64";
            media_type: string;
            data: string;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }, {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }>]>, "many">]>;
    is_error: z.ZodOptional<z.ZodBoolean>;
    cache_control: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"ephemeral">;
    }, "strip", z.ZodTypeAny, {
        type: "ephemeral";
    }, {
        type: "ephemeral";
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "tool_result";
    tool_use_id: string;
    content: string | ({
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    } | {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    } | {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    })[];
    cache_control?: {
        type: "ephemeral";
    } | undefined;
    is_error?: boolean | undefined;
}, {
    type: "tool_result";
    tool_use_id: string;
    content: string | ({
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    } | {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    } | {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    })[];
    cache_control?: {
        type: "ephemeral";
    } | undefined;
    is_error?: boolean | undefined;
}>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export declare const contentBlockSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    cache_control: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"ephemeral">;
    }, "strip", z.ZodTypeAny, {
        type: "ephemeral";
    }, {
        type: "ephemeral";
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}, {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    } | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"thinking">;
    thinking: z.ZodString;
    signature: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "thinking";
    thinking: string;
    signature?: string | undefined;
}, {
    type: "thinking";
    thinking: string;
    signature?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    id: z.ZodString;
    name: z.ZodString;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}, {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    tool_use_id: z.ZodString;
    content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        cache_control: z.ZodOptional<z.ZodObject<{
            type: z.ZodLiteral<"ephemeral">;
        }, "strip", z.ZodTypeAny, {
            type: "ephemeral";
        }, {
            type: "ephemeral";
        }>>;
    }, "strip", z.ZodTypeAny, {
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    }, {
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        source: z.ZodObject<{
            type: z.ZodLiteral<"base64">;
            media_type: z.ZodString;
            data: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "base64";
            media_type: string;
            data: string;
        }, {
            type: "base64";
            media_type: string;
            data: string;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }, {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }>, z.ZodObject<{
        type: z.ZodLiteral<"document">;
        source: z.ZodObject<{
            type: z.ZodLiteral<"base64">;
            media_type: z.ZodString;
            data: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "base64";
            media_type: string;
            data: string;
        }, {
            type: "base64";
            media_type: string;
            data: string;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }, {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }>]>, "many">]>;
    is_error: z.ZodOptional<z.ZodBoolean>;
    cache_control: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"ephemeral">;
    }, "strip", z.ZodTypeAny, {
        type: "ephemeral";
    }, {
        type: "ephemeral";
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "tool_result";
    tool_use_id: string;
    content: string | ({
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    } | {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    } | {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    })[];
    cache_control?: {
        type: "ephemeral";
    } | undefined;
    is_error?: boolean | undefined;
}, {
    type: "tool_result";
    tool_use_id: string;
    content: string | ({
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    } | {
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    } | {
        type: "document";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    })[];
    cache_control?: {
        type: "ephemeral";
    } | undefined;
    is_error?: boolean | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"document">;
    source: z.ZodObject<{
        type: z.ZodLiteral<"base64">;
        media_type: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "base64";
        media_type: string;
        data: string;
    }, {
        type: "base64";
        media_type: string;
        data: string;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}, {
    type: "document";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}>]>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
