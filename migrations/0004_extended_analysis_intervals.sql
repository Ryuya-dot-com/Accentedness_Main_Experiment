DROP VIEW IF EXISTS analysis_intervals;

CREATE VIEW analysis_intervals AS
SELECT
  p.participant_uuid,
  p.numeric_id,
  pre_visit.visit_uuid AS pre_visit_uuid,
  immediate_visit.visit_uuid AS immediate_visit_uuid,
  delayed_visit.visit_uuid AS delayed_visit_uuid,
  pre_visit.behavioral_completed_at_ms AS pre_behavioral_completed_at_ms,
  immediate_learning.started_at_ms AS immediate_learning_started_at_ms,
  CASE
    WHEN pre_visit.behavioral_completed_at_ms IS NOT NULL
      AND immediate_learning.started_at_ms IS NOT NULL
    THEN immediate_learning.started_at_ms - pre_visit.behavioral_completed_at_ms
    ELSE NULL
  END AS pre_to_learning_interval_ms,
  -- Keep every column from migration 0003 in its original position. New
  -- anchors and intervals are appended below for SELECT * compatibility.
  immediate_visit.behavioral_completed_at_ms AS immediate_behavioral_completed_at_ms,
  delayed_picture_naming.started_at_ms AS delayed_picture_naming_started_at_ms,
  CASE
    WHEN immediate_visit.behavioral_completed_at_ms IS NOT NULL
      AND delayed_picture_naming.started_at_ms IS NOT NULL
    THEN delayed_picture_naming.started_at_ms - immediate_visit.behavioral_completed_at_ms
    ELSE NULL
  END AS retention_interval_ms,
  delayed_visit.target_at_ms AS delayed_target_at_ms,
  CASE
    WHEN delayed_visit.target_at_ms IS NOT NULL
      AND delayed_picture_naming.started_at_ms IS NOT NULL
    THEN delayed_picture_naming.started_at_ms - delayed_visit.target_at_ms
    ELSE NULL
  END AS target_deviation_ms,
  immediate_learning.completed_at_ms AS immediate_learning_completed_at_ms,
  immediate_picture_naming.started_at_ms AS immediate_picture_naming_started_at_ms,
  CASE
    WHEN immediate_learning.completed_at_ms IS NOT NULL
      AND immediate_picture_naming.started_at_ms IS NOT NULL
    THEN immediate_picture_naming.started_at_ms - immediate_learning.completed_at_ms
    ELSE NULL
  END AS learning_to_immediate_pn_interval_ms,
  immediate_picture_naming.completed_at_ms AS immediate_picture_naming_completed_at_ms,
  immediate_l2_to_l1.started_at_ms AS immediate_l2_to_l1_started_at_ms,
  CASE
    WHEN immediate_picture_naming.completed_at_ms IS NOT NULL
      AND immediate_l2_to_l1.started_at_ms IS NOT NULL
    THEN immediate_l2_to_l1.started_at_ms - immediate_picture_naming.completed_at_ms
    ELSE NULL
  END AS immediate_pn_to_l2_interval_ms,
  delayed_picture_naming.completed_at_ms AS delayed_picture_naming_completed_at_ms,
  delayed_l2_to_l1.started_at_ms AS delayed_l2_to_l1_started_at_ms,
  CASE
    WHEN delayed_picture_naming.completed_at_ms IS NOT NULL
      AND delayed_l2_to_l1.started_at_ms IS NOT NULL
    THEN delayed_l2_to_l1.started_at_ms - delayed_picture_naming.completed_at_ms
    ELSE NULL
  END AS delayed_pn_to_l2_interval_ms
FROM participants p
LEFT JOIN visits pre_visit
  ON pre_visit.participant_uuid = p.participant_uuid
  AND pre_visit.visit_type = 'pre'
LEFT JOIN visits immediate_visit
  ON immediate_visit.participant_uuid = p.participant_uuid
  AND immediate_visit.visit_type = 'immediate'
LEFT JOIN segments immediate_learning
  ON immediate_learning.visit_uuid = immediate_visit.visit_uuid
  AND immediate_learning.segment = 'learning'
LEFT JOIN segments immediate_picture_naming
  ON immediate_picture_naming.visit_uuid = immediate_visit.visit_uuid
  AND immediate_picture_naming.segment = 'picture_naming'
LEFT JOIN segments immediate_l2_to_l1
  ON immediate_l2_to_l1.visit_uuid = immediate_visit.visit_uuid
  AND immediate_l2_to_l1.segment = 'l2_to_l1'
LEFT JOIN visits delayed_visit
  ON delayed_visit.participant_uuid = p.participant_uuid
  AND delayed_visit.visit_type = 'delayed'
LEFT JOIN segments delayed_picture_naming
  ON delayed_picture_naming.visit_uuid = delayed_visit.visit_uuid
  AND delayed_picture_naming.segment = 'picture_naming'
LEFT JOIN segments delayed_l2_to_l1
  ON delayed_l2_to_l1.visit_uuid = delayed_visit.visit_uuid
  AND delayed_l2_to_l1.segment = 'l2_to_l1';
