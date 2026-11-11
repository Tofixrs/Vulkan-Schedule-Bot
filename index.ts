import { parse, type HTMLElement } from "node-html-parser";
import { renderPlainSchedule, renderSchedule } from "./renderer.js";
import { LessonType } from "./types.js";
import type { Diffrence, GroupDiffrence, Lesson, LessonDiff } from "./types.js";

interface State {
	hash: number | null;
	schedule: Lesson[][];
}

const LOG_URL = Bun.env.LOG_URL ?? Bun.env.LOG_WEBHOOK;
const LOG_PING_ID = Bun.env.LOG_PING_ID ?? "";
const WEBHOOKS = (Bun.env.WEBHOOKS ?? Bun.env.ANNOUNCE_URL ?? "")
	.split(/[\n,]/)
	.map((value) => value.trim())
	.filter(Boolean);

let state: State = await Bun.file("./state.json")
	.json()
	.catch(() => ({ hash: null, schedule: [] }));

function requiredEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

async function main() {
	const baseUrl = requiredEnv("BASE_URL").replace(/\/+$/, "");
	const className = requiredEnv("CLASS");
	const listUrl = `${baseUrl}/lista.html`;

	if (!LOG_URL) {
		console.warn("LOG_URL is not set; logs will only go to stderr");
	}
	if (WEBHOOKS.length === 0) {
		console.warn("No WEBHOOKS configured; rendered plans will not be posted");
	}

	await log("MAIN", "Starting bot");
	while (true) {
		await wait(1000 * 60);
		await log("MAIN", "Trying to check diff");
		const listRes = await fetch(listUrl);
		if (!listRes.ok) {
			await log(
				"LIST",
				`Fetch error: ${listRes.statusText} (${listRes.status})`,
			);
			continue;
		}

		const listText = await listRes.text();
		const listDOM = parse(listText);
		const classLink = listDOM
			.querySelectorAll("a")
			.find((value) => value.textContent == className)?.attributes[
			"href"
		];
		if (!classLink) {
			await log("LIST", `Class not found ${className}`);
			continue;
		}

		const scheduleRes = await fetch(`${baseUrl}/${classLink}`);
		if (!scheduleRes.ok) {
			await log(
				"SCHEDULE",
				`Fetch error: ${scheduleRes.statusText} (${scheduleRes.status})`,
			);
			continue;
		}

		const scheduleText = await scheduleRes.text();
		const scheduleDom = parse(scheduleText);
		const scheduleNew: Lesson[][] = [];
		for (let i = 0; i < 5; i++) {
			scheduleNew.push(parseDay(i, scheduleDom));
		}

		if (state.hash == null) {
			await log("SCHEDULE", "No hash present skipping...");
			await setState(scheduleText, scheduleNew);
			continue;
		}
		if (state.hash == hashString(scheduleText)) {
			await log("SCHEDULE", "No changes detected...");
			continue;
		}
		if (new Date().getMonth() == 7) {
			const image = renderPlainSchedule(scheduleNew);

			await postImage(image);
			await setState(scheduleText, scheduleNew);
			continue;
		}

		const diff: Diffrence[][] = [];

		for (let i = 0; i < 5; i++) {
			const dayDiff: Diffrence[] = [];
			for (let j = 0; j < 13; j++) {
				const currLesson = scheduleNew[i][j];
				const lastLesson = state.schedule[i][j];
				if (currLesson.type != lastLesson.type) {
					dayDiff.push({ type: true });
					continue;
				}

				if (currLesson.type == LessonType.Seperate) {
					const group1Res: GroupDiffrence = {
						subject: false,
						room: false,
						teacher: false,
					};
					const group2Res: GroupDiffrence = {
						subject: false,
						room: false,
						teacher: false,
					};
					for (const k of Object.keys(currLesson.gr1!)) {
						const key = k as "subject" | "room" | "teacher";
						if (currLesson.gr1![key] == lastLesson.gr1![key]) continue;
						group1Res[key] = true;
					}
					for (const k of Object.keys(currLesson.gr2!)) {
						const key = k as "subject" | "room" | "teacher";
						if (currLesson.gr2![key] == lastLesson.gr2![key]) continue;
						group2Res[key] = true;
					}
					dayDiff.push({ type: false, gr1: group1Res, gr2: group2Res });
				} else if (currLesson.type == LessonType.All) {
					const res: GroupDiffrence = {
						subject: false,
						room: false,
						teacher: false,
					};
					for (const k of Object.keys(currLesson.all!)) {
						const key = k as "subject" | "room" | "teacher";
						if (currLesson.all![key] == lastLesson.all![key]) continue;
						res[key] = true;
					}
					dayDiff.push({ type: false, all: res });
				} else {
					dayDiff.push({ type: false });
				}
			}
			diff.push(dayDiff);
		}

		const days: LessonDiff[][] = [];

		for (let i = 0; i < 5; i++) {
			const dayData: LessonDiff[] = [];
			for (let j = 0; j < 13; j++) {
				dayData.push({
					old: state.schedule[i][j],
					new: scheduleNew[i][j],
					diff: diff[i][j],
				});
			}
			days.push(dayData);
		}

		const image = renderSchedule(days);

		await postImage(image);
		await setState(scheduleText, scheduleNew);
	}
}

async function postImage(image: Buffer) {
	if (WEBHOOKS.length === 0) return;

	const body = new FormData();
	body.append("file", new Blob([new Uint8Array(image)]), "plan.png");

	await Promise.all(
		WEBHOOKS.map((url) =>
			fetch(url, {
				method: "POST",
				body,
			}),
		),
	);
}

export function parseDay(dayNr: number, node: HTMLElement): Lesson[] {
	let res = node
		.querySelectorAll(`.tabela tr td:nth-child(${dayNr + 3})`)
		.map((v) => {
			const nr = parseInt(v.parentNode.querySelector(".nr")!.textContent);
			if (v.children.length == 0) return { type: LessonType.Empty, nr };
			const subjects = v.querySelectorAll(".p");
			const teachers = subjects.map((v) => v.querySelector("+.n")!);
			const rooms = teachers.map((v) => v.querySelector("+.s"));

			if (subjects.length > 1) {
				return {
					gr1: {
						teacher: teachers[0]!.textContent,
						subject: subjects[0].textContent,
						room: rooms[0]!.textContent,
					},
					gr2: {
						teacher: teachers[1]!.textContent,
						subject: subjects[1].textContent,
						room: rooms[1]!.textContent,
					},
					type: LessonType.Seperate,
					nr,
				};
			} else {
				return {
					all: {
						teacher: teachers[0]!.textContent,
						subject: subjects[0].textContent,
						room: rooms[0]!.textContent,
					},
					type: LessonType.All,
					nr,
				};
			}
		})
		.sort((a, b) => a.nr - b.nr);

	if (res.length < 13) {
		const lastNr = res[res.length - 1].nr;
		const firstNr = res[0].nr;
		res.push(
			...Array.from({ length: 13 - lastNr }).map((_, i) => ({
				nr: lastNr + i + 1,
				type: LessonType.Empty,
			})),
		);
		if (firstNr != 1) {
			res = [
				...Array.from({ length: firstNr - 1 }).map((_, i) => ({
					nr: i + 1,
					type: LessonType.Empty,
				})),
				...res,
			];
		}
	}
	return res;
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

async function setState(text: string, scheduleNew: Lesson[][]) {
	state = { hash: hashString(text), schedule: scheduleNew };
	await Bun.write("./state.json", JSON.stringify(state));
}

async function log(header: string, text: string) {
	const message = `[${header}]: ${text}`;

	if (!LOG_URL) {
		console.error(message);
		return;
	}

	try {
		await fetch(LOG_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ content: message }),
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
		await log("MAIN", ping + String(error));
		throw error;
	}
})();
