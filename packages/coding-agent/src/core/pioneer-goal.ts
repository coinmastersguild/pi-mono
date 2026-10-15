import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const GOAL_ENTRY = "pioneer-goal";
export const GOAL_CONTEXT = "pioneer-goal-context";
export const DEFAULT_GOAL_TURNS = 20;
export const MAX_GOAL_TURNS = 1000;

const GoalSchema = Type.Object({
	version: Type.Literal(1),
	id: Type.String({ minLength: 1, maxLength: 100 }),
	objective: Type.String({ minLength: 1, maxLength: 16000 }),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("paused"),
		Type.Literal("blocked"),
		Type.Literal("complete"),
		Type.Literal("cancelled"),
	]),
	turns: Type.Integer({ minimum: 0 }),
	runTurns: Type.Integer({ minimum: 0 }),
	maxTurns: Type.Integer({ minimum: 1, maximum: MAX_GOAL_TURNS }),
	summary: Type.String({ maxLength: 4000 }),
	pauseReason: Type.String({ maxLength: 500 }),
	evidence: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 16 }),
	updatedAt: Type.Integer({ minimum: 0 }),
});

export type PioneerGoal = Static<typeof GoalSchema>;

export function readPioneerGoal(value: unknown): PioneerGoal {
	if (
		!Check(GoalSchema, value) ||
		!value.objective.trim() ||
		value.runTurns > value.maxTurns ||
		value.turns < value.runTurns ||
		value.evidence.some((item) => !item.trim()) ||
		(value.status === "complete" && !value.evidence.length)
	) {
		throw new Error("Saved goal is invalid; preserve the session before recovery");
	}
	return value;
}
