export interface RegistrationDraftInput {
  readonly trainerName: string;
  readonly age: number;
  readonly genderPronouns: string;
  readonly appearance: string;
  readonly personality: string;
  readonly backstory: string;
  readonly starterFormId: string;
  readonly regionId: string;
  readonly schemaVersion: number;
}

export interface RegistrationSnapshot {
  readonly trainerName: string;
  readonly age: number;
  readonly genderPronouns: string;
  readonly appearance: string;
  readonly personality: string;
  readonly backstory: string;
  readonly starterFormId: string;
  readonly regionId: string;
  readonly schemaVersion: number;
}
