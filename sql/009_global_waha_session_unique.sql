DO $$
BEGIN
  IF EXISTS (SELECT session FROM channels GROUP BY session HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Cannot enforce global WAHA session uniqueness while duplicate channel sessions exist';
  END IF;
END
$$;

CREATE UNIQUE INDEX channels_session_unique ON channels(session);
