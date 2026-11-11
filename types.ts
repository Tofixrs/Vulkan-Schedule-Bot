export interface GroupDifference {
	subject: boolean;
	room: boolean;
	teacher: boolean;
}

export interface Group {
	subject: string;
	teacher: string;
	room: string;
}

export enum LessonType {
	Separate = 0,
	All = 1,
	Empty = 2,
}

interface BaseLesson {
	nr: number;
}

export interface AllLesson extends BaseLesson {
	type: LessonType.All;
	all: Group;
}

export interface SeparateLesson extends BaseLesson {
	type: LessonType.Separate;
	gr1: Group;
	gr2: Group;
}

export interface EmptyLesson extends BaseLesson {
	type: LessonType.Empty;
}

export type Lesson = AllLesson | SeparateLesson | EmptyLesson;

export type Difference =
	| { kind: "none" }
	| { kind: "type" }
	| { kind: "all"; all: GroupDifference }
	| { kind: "separate"; gr1: GroupDifference; gr2: GroupDifference };

export interface LessonDiff {
	old: Lesson;
	next: Lesson;
	diff: Difference;
}

export interface ScheduleMeta {
	dayNames: string[];
	hours: string[];
}
