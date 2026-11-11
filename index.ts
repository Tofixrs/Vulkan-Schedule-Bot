import { parse, type HTMLElement } from "node-html-parser";
import {
	DEFAULT_DAY_NAMES,
	DEFAULT_HOURS,
	MIN_LESSONS,
	REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { renderPlainSchedule, renderSchedule } from "./renderer.js";
import { LessonType } from "./types.js";
import type {
	Difference,
	Group,
	GroupDifference,
	Lesson,
	LessonDiff,
	ScheduleMeta,
} from "./types.js";

interface ClassState {
	hash: number | null;
	schedule: Lesson[][];
}

type State = Record<string, ClassState>;

interface ClassConfig {
	name: string;
	webhooks: string[];
}

const LOG_URL = Bun.env.LOG_URL ?? Bun.env.LOG_WEBHOOK;
const LOG_PING_ID = Bun.env.LOG_PING_ID ?? "";
const WEBHOOKS = (Bun.env.WEBHOOKS ?? Bun.env.ANNOUNCE_URL ?? "")
	.split(/[\n,]/)
	.map((value) => value.trim())
	.filter(Boolean);

let state: State = {};

const rawState: unknown = await Bun.file("./state.json")
	.json()
	.catch(() => null);
if (rawState && typeof rawState === "object" && !Array.isArray(rawState)) {
	state = rawState as State;
}

function requiredEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

function parseClassConfig(): ClassConfig[] {
	const raw = (Bun.env.CLASS_WEBHOOKS ?? "").trim();
	if (!raw) {
		const name = requiredEnv("CLASS").trim();
		return [{ name, webhooks: WEBHOOKS }];
	}

	const classes = new Map<string, string[]>();
	for (const entry of raw.replace(/\\n/g, "\n").split(/[\n;]/)) {
		const line = entry.trim();
		if (!line || line.startsWith("#")) continue;

		const separator = line.indexOf("=");
		if (separator === -1) {
			throw new Error(
				`Invalid CLASS_WEBHOOKS entry (expected CLASS=webhook): ${line}`,
			);
		}

		const name = line.slice(0, separator).trim();
		const webhooks = line
			.slice(separator + 1)
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);

		if (!name || webhooks.length === 0) {
			throw new Error(
				`Invalid CLASS_WEBHOOKS entry (expected CLASS=webhook): ${line}`,
			);
		}

		const existing = classes.get(name) ?? [];
		classes.set(name, [...new Set([...existing, ...webhooks])]);
	}

	if (classes.size === 0) {
		throw new Error("CLASS_WEBHOOKS is set but contains no classes");
	}

	return [...classes].map(([name, webhooks]) => ({ name, webhooks }));
}

async function saveState() {
	await Bun.write("./state.json", JSON.stringify(state));
}

function schoolFetch(url: string) {
	return fetch(url, {
		tls: { rejectUnauthorized: false },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

async function main() {
	const baseUrl = requiredEnv("BASE_URL").replace(/\/+$/, "");
	const classes = parseClassConfig();
	const listUrl = `${baseUrl}/lista.html`;
	const runOnce = Bun.env.RUN_ONCE === "1";
	const interval = Number(Bun.env.CHECK_INTERVAL_MS ?? 1000 * 60);

	if (!LOG_URL) {
		console.warn("LOG_URL is not set; logs will only go to the console");
	}
	if (classes.reduce((sum, cls) => sum + cls.webhooks.length, 0) === 0) {
		console.warn("No webhooks configured; rendered plans will not be posted");
	}

	await log(
		"MAIN",
		`Starting bot for ${classes.map((cls) => cls.name).join(", ")}`,
	);

	for (;;) {
		if (!runOnce) await wait(interval);
		await log("MAIN", "Trying to check diff");
		await checkOnce(baseUrl, classes, listUrl);
		if (runOnce) break;
	}
}

async function checkOnce(
	baseUrl: string,
	classes: ClassConfig[],
	listUrl: string,
) {
	const listRes = await schoolFetch(listUrl);
	if (!listRes.ok) {
		await log(
			"LIST",
			`Fetch error: ${listRes.statusText} (${listRes.status})`,
			"error",
		);
		return;
	}

	const listText = await listRes.text();
	const listDOM = parse(listText);

	for (const cls of classes) {
		const classLink = listDOM
			.querySelectorAll("a")
			.find((value) => value.textContent.trim() === cls.name)
			?.attributes["href"];
		if (!classLink) {
			await log("LIST", `${cls.name}: Class not found`, "error");
			continue;
		}

		await checkClass(baseUrl, cls, classLink);
	}
}

async function checkClass(
	baseUrl: string,
	cls: ClassConfig,
	classLink: string,
) {
	const scheduleUrl = new URL(classLink, `${baseUrl}/`).href;
	const scheduleRes = await schoolFetch(scheduleUrl);
	if (!scheduleRes.ok) {
		await log(
			"SCHEDULE",
			`${cls.name}: Fetch error: ${scheduleRes.statusText} (${scheduleRes.status})`,
			"error",
		);
		return;
	}

	const scheduleText = await scheduleRes.text();
	const scheduleDom = parse(scheduleText);
	const meta = parseMeta(scheduleDom);
	const scheduleNew: Lesson[][] = [];
	for (let i = 0; i < meta.dayNames.length; i++) {
		scheduleNew.push(parseDay(i, scheduleDom));
	}

	const previous = state[cls.name] ?? { hash: null, schedule: [] };

	if (previous.hash == null) {
		await log("SCHEDULE", `${cls.name}: No hash present skipping...`);
		await setState(cls.name, scheduleText, scheduleNew);
		return;
	}
	if (previous.hash == hashString(scheduleText)) {
		await log("SCHEDULE", `${cls.name}: No changes detected...`);
		return;
	}
	if (new Date().getMonth() == 7) {
		const image = renderPlainSchedule(scheduleNew, meta);

		if (!(await postImage(cls, image))) {
			await log(
				"SCHEDULE",
				`${cls.name}: Plan was not posted; keeping previous state`,
				"error",
			);
			return;
		}
		await setState(cls.name, scheduleText, scheduleNew);
		return;
	}

	const days = buildDiffDays(previous.schedule, scheduleNew);
	const image = renderSchedule(days, meta);

	if (!(await postImage(cls, image))) {
		await log(
			"SCHEDULE",
			`${cls.name}: Plan was not posted; keeping previous state`,
			"error",
		);
		return;
	}
	await setState(cls.name, scheduleText, scheduleNew);
}

async function postImage(cls: ClassConfig, image: Buffer): Promise<boolean> {
	if (cls.webhooks.length === 0) return true;

	const results = await Promise.allSettled(
		cls.webhooks.map(async (url) => {
			const body = new FormData();
			body.append("file", new Blob([new Uint8Array(image)]), "plan.png");

			const res = await fetch(url, {
				method: "POST",
				body,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!res.ok) {
				throw new Error(
					`Webhook post failed: ${res.status} ${res.statusText}`,
				);
			}
			return res.status;
		}),
	);

	let posted = 0;
	for (const result of results) {
		if (result.status === "fulfilled") posted++;
		else console.error(`Webhook post failed for ${cls.name}:`, result.reason);
	}
	console.log(
		`Posted ${cls.name} plan to ${posted}/${cls.webhooks.length} webhook(s)`,
	);
	return posted > 0;
}

function emptyLesson(nr: number): Lesson {
	return { type: LessonType.Empty, nr };
}

function diffGroup(oldGroup: Group, nextGroup: Group): GroupDifference {
	return {
		subject: oldGroup.subject !== nextGroup.subject,
		room: oldGroup.room !== nextGroup.room,
		teacher: oldGroup.teacher !== nextGroup.teacher,
	};
}

function diffLessons(oldLesson: Lesson, nextLesson: Lesson): Difference {
	if (oldLesson.type !== nextLesson.type) return { kind: "type" };

	switch (oldLesson.type) {
		case LessonType.All:
			if (nextLesson.type !== LessonType.All) return { kind: "type" };
			return {
				kind: "all",
				all: diffGroup(oldLesson.all, nextLesson.all),
			};
		case LessonType.Separate:
			if (nextLesson.type !== LessonType.Separate) {
				return { kind: "type" };
			}
			return {
				kind: "separate",
				gr1: diffGroup(oldLesson.gr1, nextLesson.gr1),
				gr2: diffGroup(oldLesson.gr2, nextLesson.gr2),
			};
		case LessonType.Empty:
			return { kind: "none" };
	}

	return { kind: "none" };
}

function buildDiffDays(
	previousSchedule: Lesson[][],
	currentSchedule: Lesson[][],
): LessonDiff[][] {
	const rows = currentSchedule.reduce(
		(max, currentDay, day) =>
			Math.max(max, currentDay.length, previousSchedule[day]?.length ?? 0),
		0,
	);

	return currentSchedule.map((currentDay, day) => {
		const previousDay = previousSchedule[day] ?? [];
		const dayData: LessonDiff[] = [];

		for (let row = 0; row < rows; row++) {
			const oldLesson = previousDay[row] ?? emptyLesson(row + 1);
			const nextLesson = currentDay[row] ?? emptyLesson(row + 1);
			dayData.push({
				old: oldLesson,
				next: nextLesson,
				diff: diffLessons(oldLesson, nextLesson),
			});
		}

		return dayData;
	});
}

export function parseMeta(node: HTMLElement): ScheduleMeta {
	const table = node.querySelector(".tabela");
	const headerCells =
		table?.querySelectorAll("tr")[0]?.querySelectorAll("th") ?? [];
	const dayNames = headerCells
		.slice(2)
		.map((cell) => cell.textContent.trim())
		.filter(Boolean);

	const hoursByNumber = new Map<number, string>();
	for (const cell of table?.querySelectorAll("td.g") ?? []) {
		const nrText = cell.parentNode?.querySelector(".nr")?.textContent ?? "";
		const nr = Number.parseInt(nrText, 10);
		if (!Number.isFinite(nr)) continue;

		const label = cell.textContent.trim().replace(/\s*-\s*/g, "-");
		if (label) hoursByNumber.set(nr, label);
	}

	const lessonCount = Math.max(MIN_LESSONS, ...hoursByNumber.keys());
	return {
		dayNames: dayNames.length > 0 ? dayNames : DEFAULT_DAY_NAMES,
		hours: Array.from(
			{ length: lessonCount },
			(_, index) =>
				hoursByNumber.get(index + 1) ?? DEFAULT_HOURS[index] ?? "",
		),
	};
}

export function parseDay(dayNr: number, node: HTMLElement): Lesson[] {
	const byNumber = new Map<number, Lesson>();

	for (const cell of node.querySelectorAll(
		`.tabela tr td:nth-child(${dayNr + 3})`,
	)) {
		const nrText = cell.parentNode?.querySelector(".nr")?.textContent ?? "";
		const nr = Number.parseInt(nrText, 10);
		if (!Number.isFinite(nr)) continue;

		const subjects = cell.querySelectorAll(".p");
		if (subjects.length === 0) {
			byNumber.set(nr, emptyLesson(nr));
			continue;
		}

		const teacherNodes = subjects.map((subject) =>
			subject.querySelector("+.n"),
		);
		const teachers = teacherNodes.map(
			(teacher) => teacher?.textContent.trim() ?? "",
		);
		const rooms = teacherNodes.map(
			(teacher) => teacher?.querySelector("+.s")?.textContent.trim() ?? "",
		);

		if (subjects.length > 1) {
			byNumber.set(nr, {
				type: LessonType.Separate,
				nr,
				gr1: {
					teacher: teachers[0] ?? "",
					subject: subjects[0].textContent.trim(),
					room: rooms[0] ?? "",
				},
				gr2: {
					teacher: teachers[1] ?? "",
					subject: subjects[1].textContent.trim(),
					room: rooms[1] ?? "",
				},
			});
		} else {
			byNumber.set(nr, {
				type: LessonType.All,
				nr,
				all: {
					teacher: teachers[0] ?? "",
					subject: subjects[0].textContent.trim(),
					room: rooms[0] ?? "",
				},
			});
		}
	}

	const lessonCount = Math.max(MIN_LESSONS, ...byNumber.keys());
	return Array.from(
		{ length: lessonCount },
		(_, index) => byNumber.get(index + 1) ?? emptyLesson(index + 1),
	);
}

function hashString(s: string) {
	let hash = 0,
		i,
		chr;
	if (s.length === 0) return hash;
	for (i = 0; i < s.length; i++) {
		chr = s.charCodeAt(i);
		hash = (hash << 5) - hash + chr;
		hash |= 0; // Convert to 32bit integer
	}
	return hash;
}

async function setState(
	className: string,
	text: string,
	scheduleNew: Lesson[][],
) {
	state[className] = { hash: hashString(text), schedule: scheduleNew };
	await saveState();
}

type LogLevel = "info" | "error";

async function log(
	header: string,
	text: string,
	level: LogLevel = "info",
) {
	const message = `[${header}]: ${text}`;

	console.log(message);

	if (level === "info" || !LOG_URL) {
		return;
	}

	try {
		await fetch(LOG_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ content: message }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		console.error("log webhook failed:", error);
	}
}

function wait(time: number) {
	return new Promise((res, _rej) => setTimeout(res, time));
}

(async () => {
	try {
		await main();
	} catch (error) {
		const ping = LOG_PING_ID ? `<@${LOG_PING_ID}> ` : "";
		await log("MAIN", ping + String(error), "error");
		throw error;
	}
})();
