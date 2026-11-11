export interface GroupDiffrence {
	subject: boolean;
	room: boolean;
	teacher: boolean;
}

export interface Diffrence {
	gr1?: GroupDiffrence;
	gr2?: GroupDiffrence;
	all?: GroupDiffrence;
	type: boolean;
}

export interface Group {
	subject: string;
	teacher: string;
	room: string;
}

export enum LessonType {
	Seperate,
	All,
	Empty,
}

export interface Lesson {
	all?: Group;
	gr1?: Group;
	gr2?: Group;
	type: LessonType;
	nr: number;
}

export interface LessonDiff {
	old: Lesson;
	new: Lesson;
	diff: Diffrence;
}
