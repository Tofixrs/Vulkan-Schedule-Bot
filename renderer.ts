import {
	createCanvas,
	GlobalFonts,
	type SKRSContext2D,
} from "@napi-rs/canvas";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LessonType } from "./types.js";
import type {
	Group,
	GroupDifference,
	Lesson,
	LessonDiff,
	ScheduleMeta,
} from "./types.js";

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "fonts");

const WIDTH = 1920;
const PAD = 24;
const CARD_X = PAD;
const CARD_Y = PAD;
const CARD_W = WIDTH - PAD * 2;
const HEADER_H = 60;
const MIN_ROW_H = 100;
const NUM_W = 60;
const HOUR_W = 160;

const BOX_H = 48;
const BOX_GAP = 4;
const CELL_PAD = 6;

const COLORS = {
	bg: "#f1f5f9",
	card: "#ffffff",
	ink: "#0f172a",
	slate300: "#cbd5e1",
	slate600: "#475569",
	headerBg: "#1e293b",
	headerBorder: "#334155",
	cellBorder: "#e2e8f0",
	rowAlt: "#fafbfd",
	numBg: "#f8fafc",
	numText: "#94a3b8",
	diffOldBg: "#fff1f2",
	diffOldBorder: "#fecdd3",
	diffOldText: "#be123c",
	diffNewBg: "#f0fdf4",
	diffNewBorder: "#bbf7d0",
	diffNewText: "#15803d",
} as const;

type GroupVariant = "plain" | "old" | "new";
type GroupBox = { group: Group; variant: GroupVariant };

let fontsReady = false;

function ensureFonts() {
	if (fontsReady) return;

	const fonts: [file: string, alias: string][] = [
		["Manrope-Variable.ttf", "Manrope"],
		["IBMPlexMono-Medium.ttf", "PlexMono"],
		["IBMPlexMono-SemiBold.ttf", "PlexMonoSemiBold"],
	];

	for (const [file, alias] of fonts) {
		const key = GlobalFonts.registerFromPath(join(FONT_DIR, file), alias);
		if (!key) throw new Error(`Failed to register font: ${file}`);
	}

	fontsReady = true;
}

function setManrope(ctx: SKRSContext2D, weight: number, size: number) {
	ctx.font = `${weight} ${size}px Manrope`;
	ctx.fontVariationSettings = `"wght" ${weight}`;
}

function setPlex(ctx: SKRSContext2D, weight: 500 | 600, size: number) {
	ctx.fontVariationSettings = "normal";
	ctx.font = `${weight} ${size}px ${weight === 600 ? "PlexMonoSemiBold" : "PlexMono"}`;
}

function rounded(
	ctx: SKRSContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) {
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx: SKRSContext2D, text: string, maxWidth: number) {
	if (maxWidth <= 0) return "";
	if (ctx.measureText(text).width <= maxWidth) return text;

	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = `${text.slice(0, mid)}…`;
		if (ctx.measureText(candidate).width <= maxWidth) low = mid;
		else high = mid - 1;
	}

	return low > 0 ? `${text.slice(0, low)}…` : "";
}

function wrapText(
	ctx: SKRSContext2D,
	text: string,
	maxWidth: number,
	maxLines: number,
) {
	if (maxLines <= 0 || maxWidth <= 0) return [];

	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];

	const lines: string[] = [];
	let current = "";
	let index = 0;

	while (index < words.length && lines.length < maxLines) {
		const word = words[index];
		const candidate = current ? `${current} ${word}` : word;

		if (ctx.measureText(candidate).width <= maxWidth) {
			current = candidate;
			index++;
			continue;
		}

		if (current) {
			lines.push(current);
			current = "";
			continue;
		}

		lines.push(fitText(ctx, word, maxWidth));
		index++;
	}

	if (current) {
		if (lines.length < maxLines) lines.push(current);
		else
			lines[lines.length - 1] = fitText(
				ctx,
				`${lines[lines.length - 1]} ${current}`,
				maxWidth,
			);
	}

	if (index < words.length && lines.length > 0) {
		const rest = words.slice(index).join(" ");
		lines[lines.length - 1] = fitText(
			ctx,
			`${lines[lines.length - 1]} ${rest}`,
			maxWidth,
		);
	}

	return lines;
}

function drawStrike(ctx: SKRSContext2D, x1: number, x2: number, y: number) {
	ctx.beginPath();
	ctx.moveTo(x1, y);
	ctx.lineTo(x2, y);
	ctx.stroke();
}

function drawGroup(
	ctx: SKRSContext2D,
	group: Group,
	x: number,
	y: number,
	w: number,
	h: number,
	variant: GroupVariant,
) {
	if (variant !== "plain") {
		ctx.fillStyle =
			variant === "old" ? COLORS.diffOldBg : COLORS.diffNewBg;
		rounded(ctx, x, y, w, h, 6);
		ctx.fill();

		ctx.strokeStyle =
			variant === "old" ? COLORS.diffOldBorder : COLORS.diffNewBorder;
		ctx.lineWidth = 1;
		rounded(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 6);
		ctx.stroke();
	}

	const isOld = variant === "old";
	const color =
		variant === "old"
			? COLORS.diffOldText
			: variant === "new"
				? COLORS.diffNewText
				: COLORS.ink;

	const subjectWeight = isOld ? 500 : variant === "new" ? 800 : 600;
	const subjectSize = isOld ? 16 : 18;
	const teacherSize = isOld ? 13 : 15;
	const roomSize = isOld ? 15 : 18;
	const maxSubjectLines = isOld ? 1 : 2;
	const lineHeight = subjectSize * 1.1;

	const padX = 10;
	const innerX = x + padX;
	const innerW = w - padX * 2;
	const gap = 10;
	const midY = y + h / 2;

	const roomText = group.room ?? "";
	const teacherText = group.teacher ?? "";
	const subjectText = group.subject ?? "";

	setPlex(ctx, 600, roomSize);
	const roomWidth = roomText ? ctx.measureText(roomText).width : 0;

	setPlex(ctx, 500, teacherSize);
	const maxTeacherWidth = Math.max(0, innerW * 0.45);
	const teacher = fitText(ctx, teacherText, maxTeacherWidth);
	const teacherWidth = teacher ? ctx.measureText(teacher).width : 0;

	const roomBlock = roomWidth > 0 ? roomWidth + gap : 0;
	const teacherBlock = teacherWidth > 0 ? teacherWidth + gap : 0;
	const subjectMax = Math.max(0, innerW - roomBlock - teacherBlock);

	setManrope(ctx, subjectWeight, subjectSize);
	const subjectLines = wrapText(
		ctx,
		subjectText,
		subjectMax,
		maxSubjectLines,
	);
	const lineWidths = subjectLines.map((line) => ctx.measureText(line).width);

	ctx.textBaseline = "middle";
	ctx.textAlign = "left";
	ctx.fillStyle = color;

	const firstLineY = midY - ((subjectLines.length - 1) * lineHeight) / 2;
	subjectLines.forEach((line, index) => {
		if (line) ctx.fillText(line, innerX, firstLineY + index * lineHeight);
	});

	let teacherX = 0;
	if (teacher) {
		setPlex(ctx, 500, teacherSize);
		teacherX = innerX + innerW - roomBlock;

		ctx.save();
		ctx.globalAlpha = 0.8;
		ctx.fillStyle = color;
		ctx.textAlign = "right";
		ctx.fillText(teacher, teacherX, midY);
		ctx.restore();
	}

	if (roomText) {
		setPlex(ctx, 600, roomSize);
		ctx.fillStyle = color;
		ctx.textAlign = "right";
		ctx.fillText(roomText, innerX + innerW, midY);
	}

	if (isOld) {
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.globalAlpha = 0.7;
		subjectLines.forEach((line, index) => {
			if (line)
				drawStrike(
					ctx,
					innerX,
					innerX + lineWidths[index],
					firstLineY + index * lineHeight + 1,
				);
		});
		if (teacher)
			drawStrike(
				ctx,
				teacherX - teacherWidth,
				teacherX,
				midY + 1,
			);
		if (roomText)
			drawStrike(
				ctx,
				innerX + innerW - roomWidth,
				innerX + innerW,
				midY + 1,
			);
		ctx.restore();
	}

	ctx.textAlign = "left";
}

function drawGroupStack(
	ctx: SKRSContext2D,
	boxes: GroupBox[],
	x: number,
	y: number,
	w: number,
	h: number,
) {
	if (boxes.length === 0) return;

	const total = boxes.length * BOX_H + (boxes.length - 1) * BOX_GAP;
	let currentY = y + (h - total) / 2;

	for (const { group, variant } of boxes) {
		drawGroup(ctx, group, x, currentY, w, BOX_H, variant);
		currentY += BOX_H + BOX_GAP;
	}
}

function lessonBoxes(lesson: Lesson, variant: GroupVariant): GroupBox[] {
	switch (lesson.type) {
		case LessonType.All:
			return [{ group: lesson.all, variant }];
		case LessonType.Separate:
			return [
				{ group: lesson.gr1, variant },
				{ group: lesson.gr2, variant },
			];
		case LessonType.Empty:
			return [];
	}
}

function groupDiffBoxes(
	oldGroup: Group,
	newGroup: Group,
	diff: GroupDifference,
): GroupBox[] {
	const changed = diff.teacher || diff.subject || diff.room;

	if (!changed) return [{ group: newGroup, variant: "plain" }];

	return [
		{ group: oldGroup, variant: "old" },
		{ group: newGroup, variant: "new" },
	];
}

function lessonDiffBoxes(item: LessonDiff): GroupBox[] {
	const { old, next, diff } = item;

	switch (diff.kind) {
		case "none":
			return [];
		case "type":
			return [
				...lessonBoxes(old, "old"),
				...lessonBoxes(next, "new"),
			];
		case "all":
			if (old.type !== LessonType.All || next.type !== LessonType.All) {
				return [];
			}
			return groupDiffBoxes(old.all, next.all, diff.all);
		case "separate":
			if (
				old.type !== LessonType.Separate ||
				next.type !== LessonType.Separate
			) {
				return [];
			}
			return [
				...groupDiffBoxes(old.gr1, next.gr1, diff.gr1),
				...groupDiffBoxes(old.gr2, next.gr2, diff.gr2),
			];
	}

	return [];
}

function lessonBoxCount(lesson: Lesson): number {
	switch (lesson.type) {
		case LessonType.All:
			return 1;
		case LessonType.Separate:
			return 2;
		case LessonType.Empty:
			return 0;
	}

	return 0;
}

function rowHeight(boxCounts: number[]): number {
	const maxBoxes = Math.max(1, ...boxCounts);
	const content =
		maxBoxes * BOX_H + (maxBoxes - 1) * BOX_GAP + CELL_PAD * 2;
	return Math.max(MIN_ROW_H, content);
}

function drawTable(
	meta: ScheduleMeta,
	rowHeights: number[],
	drawCell: (
		ctx: SKRSContext2D,
		day: number,
		row: number,
		x: number,
		y: number,
		w: number,
		h: number,
	) => void,
) {
	ensureFonts();

	const days = meta.dayNames.length;
	const rows = rowHeights.length;
	const dayW = (CARD_W - NUM_W - HOUR_W) / days;
	const columns = [NUM_W, HOUR_W, ...Array.from({ length: days }, () => dayW)];
	const tableH = rowHeights.reduce((sum, h) => sum + h, HEADER_H);
	const cardH = tableH;
	const height = cardH + PAD * 2;

	const canvas = createCanvas(WIDTH, height);
	const ctx = canvas.getContext("2d");

	ctx.fillStyle = COLORS.bg;
	ctx.fillRect(0, 0, WIDTH, height);

	ctx.save();
	ctx.shadowColor = "rgba(15, 23, 42, 0.12)";
	ctx.shadowBlur = 24;
	ctx.shadowOffsetY = 10;
	ctx.fillStyle = COLORS.card;
	rounded(ctx, CARD_X, CARD_Y, CARD_W, cardH, 12);
	ctx.fill();
	ctx.restore();

	ctx.save();
	rounded(ctx, CARD_X, CARD_Y, CARD_W, cardH, 12);
	ctx.clip();

	ctx.fillStyle = COLORS.headerBg;
	ctx.fillRect(CARD_X, CARD_Y, CARD_W, HEADER_H);

	const headers = ["#", "Godz.", ...meta.dayNames];
	let headerX = CARD_X;
	for (let i = 0; i < headers.length; i++) {
		const columnW = columns[i];

		if (i < headers.length - 1) {
			ctx.strokeStyle = COLORS.headerBorder;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(headerX + columnW, CARD_Y);
			ctx.lineTo(headerX + columnW, CARD_Y + HEADER_H);
			ctx.stroke();
		}

		setManrope(ctx, 800, 20);
		ctx.fillStyle = "#ffffff";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(
			headers[i],
			headerX + columnW / 2,
			CARD_Y + HEADER_H / 2,
		);

		headerX += columnW;
	}

	const rowY: number[] = [];
	let cursorY = CARD_Y + HEADER_H;
	for (let row = 0; row < rows; row++) {
		rowY[row] = cursorY;

		const isAlt = row % 2 === 1;
		let cellX = CARD_X;
		for (let col = 0; col < columns.length; col++) {
			const columnW = columns[col];
			ctx.fillStyle =
				col < 2 ? COLORS.numBg : isAlt ? COLORS.rowAlt : COLORS.card;
			ctx.fillRect(cellX, cursorY, columnW, rowHeights[row]);
			cellX += columnW;
		}

		cursorY += rowHeights[row];
	}

	ctx.strokeStyle = COLORS.cellBorder;
	ctx.lineWidth = 1;
	for (let row = 0; row <= rows; row++) {
		const lineY = row === rows ? CARD_Y + cardH : rowY[row];
		ctx.beginPath();
		ctx.moveTo(CARD_X, lineY);
		ctx.lineTo(CARD_X + CARD_W, lineY);
		ctx.stroke();
	}
	let lineX = CARD_X;
	ctx.beginPath();
	for (let col = 0; col <= columns.length; col++) {
		ctx.moveTo(lineX, CARD_Y);
		ctx.lineTo(lineX, CARD_Y + cardH);
		lineX += columns[col] ?? 0;
	}
	ctx.stroke();

	for (let row = 0; row < rows; row++) {
		const currentY = rowY[row];
		const midY = currentY + rowHeights[row] / 2;

		setPlex(ctx, 600, 18);
		ctx.fillStyle = COLORS.numText;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(row + 1), CARD_X + NUM_W / 2, midY);

		setPlex(ctx, 500, 16);
		ctx.fillStyle = COLORS.slate600;
		ctx.fillText(
			meta.hours[row] ?? "",
			CARD_X + NUM_W + HOUR_W / 2,
			midY,
		);

		for (let day = 0; day < days; day++) {
			const dayX = CARD_X + NUM_W + HOUR_W + day * dayW;
			drawCell(
				ctx,
				day,
				row,
				dayX + CELL_PAD,
				currentY + CELL_PAD,
				dayW - CELL_PAD * 2,
				rowHeights[row] - CELL_PAD * 2,
			);
		}
	}

	ctx.restore();

	ctx.strokeStyle = COLORS.slate300;
	ctx.lineWidth = 1;
	rounded(ctx, CARD_X + 0.5, CARD_Y + 0.5, CARD_W - 1, cardH - 1, 12);
	ctx.stroke();

	return canvas.toBuffer("image/png") as Buffer;
}

function diffRowHeights(days: LessonDiff[][]): number[] {
	const rows = days[0]?.length ?? 0;
	const heights: number[] = new Array(rows).fill(MIN_ROW_H);

	for (let row = 0; row < rows; row++) {
		const counts = days.map((day) => {
			const item = day[row];
			return item ? lessonDiffBoxes(item).length : 0;
		});
		heights[row] = rowHeight(counts);
	}

	return heights;
}

function plainRowHeights(schedule: Lesson[][]): number[] {
	const rows = schedule[0]?.length ?? 0;
	const heights: number[] = new Array(rows).fill(MIN_ROW_H);

	for (let row = 0; row < rows; row++) {
		const counts = schedule.map((day) => {
			const lesson = day[row];
			return lesson ? lessonBoxCount(lesson) : 0;
		});
		heights[row] = rowHeight(counts);
	}

	return heights;
}

export function renderSchedule(
	days: LessonDiff[][],
	meta: ScheduleMeta,
): Buffer {
	const rowHeights = diffRowHeights(days);

	return drawTable(meta, rowHeights, (ctx, day, row, x, y, w, h) => {
		const item = days[day]?.[row];
		if (item) drawGroupStack(ctx, lessonDiffBoxes(item), x, y, w, h);
	});
}

export function renderPlainSchedule(
	schedule: Lesson[][],
	meta: ScheduleMeta,
): Buffer {
	const rowHeights = plainRowHeights(schedule);

	return drawTable(meta, rowHeights, (ctx, day, row, x, y, w, h) => {
		const lesson = schedule[day]?.[row];
		if (lesson) drawGroupStack(ctx, lessonBoxes(lesson, "plain"), x, y, w, h);
	});
}
