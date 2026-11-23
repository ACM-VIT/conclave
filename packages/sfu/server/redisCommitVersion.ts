export const NEXT_VERSION_LUA = `
local function nextVersion(key)
  local now = redis.call("TIME")
  local version = tonumber(now[1]) * 1000000 + tonumber(now[2])
  local last = tonumber(redis.call("GET", key) or "0") or 0
  if version <= last then version = last + 1 end
  redis.call("SET", key, string.format("%.0f", version))
  return version
end
`;
