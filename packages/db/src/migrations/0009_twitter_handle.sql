ALTER TABLE agents ADD COLUMN twitter_handle TEXT;
ALTER TABLE agents ADD COLUMN tweet_url TEXT;
CREATE UNIQUE INDEX idx_agents_twitter_handle ON agents(twitter_handle);
