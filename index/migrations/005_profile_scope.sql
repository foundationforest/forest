-- A profile lives in one market, as one side of it (shapes/README.md): its record names `market` and
-- `role`. A badge counts for the profile only under that scope, `market/role`.
alter table profiles add column market text;
alter table profiles add column role text;
