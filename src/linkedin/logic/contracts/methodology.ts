import { z } from "zod";

export type MethodologyBlock = Record<string, unknown>;

export const methodologyBlockSchema: z.ZodType<MethodologyBlock> = z.record(z.unknown());
