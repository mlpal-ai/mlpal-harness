import { z } from "zod";
export declare const roleSchema: z.ZodEnum<["user", "assistant"]>;
export type Role = z.infer<typeof roleSchema>;
export declare const messageSchema: z.ZodObject<{
    role: z.ZodEnum<["user", "assistant"]>;
    content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
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
    }>]>, "many">]>;
}, "strip", z.ZodTypeAny, {
    content: string | ({
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    } | {
        type: "thinking";
        thinking: string;
        signature?: string | undefined;
    } | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
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
    } | {
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
    })[];
    role: "user" | "assistant";
}, {
    content: string | ({
        type: "text";
        text: string;
        cache_control?: {
            type: "ephemeral";
        } | undefined;
    } | {
        type: "thinking";
        thinking: string;
        signature?: string | undefined;
    } | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
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
    } | {
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
    })[];
    role: "user" | "assistant";
}>;
export type Message = z.infer<typeof messageSchema>;
/** Anthropic stop_reason vocabulary — the gateway normalizes every provider into this. */
export declare const stopReasonSchema: z.ZodEnum<["end_turn", "tool_use", "max_tokens", "stop_sequence"]>;
export type StopReason = z.infer<typeof stopReasonSchema>;
