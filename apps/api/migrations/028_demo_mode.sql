ALTER TABLE organizations
  ADD COLUMN demo boolean NOT NULL DEFAULT false;

CREATE INDEX organizations_demo_idx ON organizations(demo) WHERE demo=true;
