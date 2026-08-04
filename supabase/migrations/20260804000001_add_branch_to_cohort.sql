-- Add branch column to cohort table for A/B testing identification by tags
-- Branch identifies which path (A, B, C...) a contact is in within a sequence

ALTER TABLE sms_analytics.cohort
ADD COLUMN branch text DEFAULT '-';

COMMENT ON COLUMN sms_analytics.cohort.branch IS 'Branch identifier (a, b, c...) from "rama X" tag in GHL. - means no branch or no tag assigned.';
