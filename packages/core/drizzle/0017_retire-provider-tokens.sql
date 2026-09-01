-- Issue #280: the first-run wizard no longer collects cloud credentials, and the
-- 'provider-token' secret kind is gone with it. Any rows the old wizard stored are deleted:
-- they were already unread wherever the environment variable or the config file supplied the
-- credential, and nothing will ever read the kind again. Every other secret kind is untouched.
DELETE FROM `secrets` WHERE `kind` = 'provider-token';
