import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-soup/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-soup/pi-coding-agent/modes/utils/ui-helpers";
import { TranscriptContainer } from "@oh-my-soup/pi-tui/chrome/transcript-container";
import { getThemeByName, setThemeInstance } from "@oh-my-soup/pi-tui/theme";
import { expandKeyHint } from "@oh-my-soup/pi-tui/render/render-utils";
import {
	NotesFrameMessageComponent,
	notesFrameKind,
	notesFrameSummary,
} from "@oh-my-soup/pi-tui/chat/user-message";

import type { Theme } from "@oh-my-soup/pi-tui/theme";

let uiTheme: Theme | undefined;

beforeAll(async () => {
	uiTheme = await getThemeByName("dark");
	if (uiTheme) setThemeInstance(uiTheme);
});

function referenceFrame(notes: Array<{ key: string; text: string; updatedAt?: string }>): string {
	return [
		"<notes-reference>",
		"Harness-injected session notes — saved by the agent itself through the notes tool.",
		JSON.stringify(notes).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
		"</notes-reference>",
		"",
	].join("\n");
}

function reminderFrame(turns: number): string {
	return [
		"<notes-update-due>",
		`Harness-injected cadence reminder, not a user turn: session notes have not been updated for ${turns} assistant turns.`,
		"</notes-update-due>",
		"",
	].join("\n");
}

function plainText(component: { render(width: number): readonly string[] }, width = 100): string {
	return component.render(width).map((line) => Bun.stripANSI(line)).join("\n");
}

describe("notes frame recognition", () => {
	it("recognizes frame-tag-prefixed developer content", () => {
		expect(notesFrameKind(referenceFrame([{ key: "k", text: "v" }]))).toBe("reference");
		expect(notesFrameKind(reminderFrame(3))).toBe("reminder");
	});

	it("does not match non-frame content, even when it mentions the tags", () => {
		expect(notesFrameKind("The <notes-reference> tag is injected by the harness.")).toBeUndefined();
		expect(notesFrameKind("")).toBeUndefined();
		expect(notesFrameKind("regular developer steering message")).toBeUndefined();
	});
});

describe("collapsed notes frame rendering", () => {
	it("summary surfaces the freshest append when notes carry updatedAt stamps", () => {
		const frame = referenceFrame([
			{ key: "working-files", text: "src/modes/utils/ui-helpers.ts", updatedAt: "2026-09-29T10:00:00.000Z" },
			{ key: "fresh-append", text: "just saved this note", updatedAt: "2026-09-29T12:00:00.000Z" },
		]);
		const component = new NotesFrameMessageComponent(frame);
		const text = plainText(component);
		// The newest-stamped note is the headline; the count line is gone.
		expect(text).toContain("fresh-append");
		expect(text).toContain("just saved this note");
		expect(text).toContain("Ctrl+O");
		expect(text).not.toContain("working-files");
		expect(text).not.toContain("2 notes");
		expect(text).not.toContain("<notes-reference>");
		const contentRows = component.render(100).filter((line) => Bun.stripANSI(line).trim().length > 0);
		expect(contentRows.length).toBe(1);
	});

	it("renders a single summary line by default and hides the raw note text", () => {
		const frame = referenceFrame([
			{ key: "working-files", text: "src/modes/utils/ui-helpers.ts" },
			{ key: "blocker", text: "waiting on upstream" },
		]);
		const component = new NotesFrameMessageComponent(frame);
		const text = plainText(component);
		expect(text).toContain("Session notes reference");
		expect(text).toContain("2 notes");
		expect(text).toContain("Ctrl+O");
		expect(text).not.toContain("ui-helpers.ts");
		expect(text).not.toContain("<notes-reference>");
		// Collapsed default: one visible content row (the summary), no body rows.
		const contentRows = component.render(100).filter((line) => Bun.stripANSI(line).trim().length > 0);
		expect(contentRows.length).toBe(1);
	});

	it("expands to the full frame under the tool-output-expanded flag and re-collapses", () => {
		const secretNote = "exact working state: bun test notes-frame-collapse.test.ts";
		const frame = referenceFrame([{ key: "state", text: secretNote }]);
		const component = new NotesFrameMessageComponent(frame);
		component.setExpanded(true);
		const expanded = plainText(component);
		expect(expanded).toContain("<notes-reference>");
		expect(expanded).toContain(secretNote);
		component.setExpanded(false);
		const collapsed = plainText(component);
		expect(collapsed).not.toContain(secretNote);
		expect(collapsed).toContain("Session notes reference");
	});

	it("collapses the reminder frame with its turns value", () => {
		const component = new NotesFrameMessageComponent(reminderFrame(7));
		const text = plainText(component);
		expect(text).toContain("Notes update reminder");
		expect(text).toContain("7 turns");
		expect(text).not.toContain("<notes-update-due>");
		expect(text).not.toContain("cadence reminder, not a user turn");
	});

	it("summary omits an unparseable count instead of guessing", () => {
		const frame = ["<notes-reference>", "prose only, no JSON payload", "</notes-reference>", ""].join("\n");
		const text = plainText(new NotesFrameMessageComponent(frame));
		expect(text).toContain("Session notes reference");
		expect(text).not.toContain("NaN");
		expect(notesFrameSummary(frame)).toBe(`Session notes reference · ${expandKeyHint()}`);
	});
});

describe("notes.collapseFrames setting gate", () => {
	const noteText = "exact working state: bun test notes-frame-collapse.test.ts";
	const frameMessage = {
		role: "developer",
		content: referenceFrame([{ key: "state", text: noteText }]),
		timestamp: 0,
	};

	function makeHelpers(collapse: boolean): { helpers: UiHelpers; chatContainer: TranscriptContainer } {
		const chatContainer = new TranscriptContainer();
		const ctx = {
			settings: Settings.isolated({ "notes.collapseFrames": collapse }),
			chatContainer,
			transcriptMessageComponents: new WeakMap(),
			toolOutputExpanded: false,
		} as unknown as InteractiveModeContext;
		return { helpers: new UiHelpers(ctx), chatContainer };
	}

	function rendered(helpers: UiHelpers, chatContainer: TranscriptContainer): string {
		helpers.addMessageToChat(frameMessage as Parameters<UiHelpers["addMessageToChat"]>[0]);
		return chatContainer.children.map((component) => plainText(component)).join("\n");
	}

	it("setting off renders the full frame inline even without expansion", () => {
		const { helpers, chatContainer } = makeHelpers(false);
		const text = rendered(helpers, chatContainer);
		expect(text).toContain("<notes-reference>");
		expect(text).toContain(noteText);
		expect(text).not.toContain("Session notes reference");
		expect(text).not.toContain("Ctrl+O");
	});

	it("setting on (default) collapses through the real render path", () => {
		const { helpers, chatContainer } = makeHelpers(true);
		const text = rendered(helpers, chatContainer);
		expect(text).toContain("Session notes reference");
		expect(text).toContain("1 note");
		expect(text).not.toContain(noteText);
	});
});
