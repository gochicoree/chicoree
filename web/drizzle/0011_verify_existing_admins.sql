-- Password sign-in now requires a verified address once a mail server is
-- configured. Administrators who exist at upgrade time were never asked to
-- verify (the installer created them, often before any mail server existed);
-- marking them verified keeps them from being locked out of their own registry.
UPDATE "user" SET "email_verified" = true WHERE "role" = 'admin';
