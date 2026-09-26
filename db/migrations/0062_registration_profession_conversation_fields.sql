-- 0062_registration_profession_conversation_fields.sql
-- Allow the required profession step to be persisted in guided and edit registration states.

ALTER TABLE registration_conversations
  DROP CONSTRAINT IF EXISTS registration_conversations_current_field_check;

ALTER TABLE registration_conversations
  ADD CONSTRAINT registration_conversations_current_field_check
  CHECK (
    current_field IS NULL OR current_field IN (
      'trainerName',
      'age',
      'genderPronouns',
      'appearance',
      'personality',
      'backstory',
      'profession',
      'starterFormId'
    )
  );

ALTER TABLE registration_conversations
  DROP CONSTRAINT IF EXISTS registration_conversations_edit_field_check;

ALTER TABLE registration_conversations
  ADD CONSTRAINT registration_conversations_edit_field_check
  CHECK (
    edit_field IS NULL OR edit_field IN (
      'trainerName',
      'age',
      'genderPronouns',
      'appearance',
      'personality',
      'backstory',
      'profession',
      'starterFormId'
    )
  );
