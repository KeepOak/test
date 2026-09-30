/** Original bounded queue script; every Redis key is declared for EVAL/cluster routing. */
export const queueScript = `
local jobs,ready,leased,tokens,orders,sequence,done = unpack(KEYS)
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local operation,id,value = ARGV[1],ARGV[2],ARGV[3]
local kinds = {'hash','zset','zset','hash','hash','string','zset'}
for n,key in ipairs(KEYS) do
  local kind = redis.call('TYPE',key).ok
  if kind ~= 'none' and kind ~= kinds[n] then return {'damaged'} end
end
if redis.call('HLEN',jobs) > 100 or redis.call('ZCARD',ready) > 100
  or redis.call('ZCARD',leased) > 100 or redis.call('HLEN',tokens) > 100
  or redis.call('HLEN',orders) > 100 or redis.call('ZCARD',done) > 1000 then return {'damaged'} end
local function touch()
  for _,key in ipairs(KEYS) do redis.call('EXPIRE',key,604800) end
end
local old = redis.call('ZRANGEBYSCORE',done,'-inf',now-86400000,'LIMIT',0,100)
for _,job in ipairs(old) do redis.call('ZREM',done,job) end
if operation == 'status' then
  return {'status',redis.call('ZCARD',ready),redis.call('ZCARD',leased)}
end
if operation == 'submit' then
  if redis.call('ZSCORE',done,id) then return {'completed',id} end
  local previous = redis.call('HGET',jobs,id)
  if previous then
    if previous ~= value then return {'conflict',id} end
    return {'existing',id}
  end
  if redis.call('HLEN',jobs) >= 100 then return {'full'} end
  if redis.call('HLEN',jobs) == 0 then redis.call('SET',sequence,0) end
  local order = redis.call('INCR',sequence)
  redis.call('HSET',jobs,id,value)
  redis.call('HSET',orders,id,order)
  redis.call('ZADD',ready,order,id)
  touch()
  return {'submitted',id}
end
if operation == 'claim' then
  local expired = redis.call('ZRANGEBYSCORE',leased,'-inf',now,'LIMIT',0,5)
  for _,job in ipairs(expired) do
    if not tonumber(redis.call('HGET',orders,job)) or not redis.call('HGET',jobs,job) then return {'damaged'} end
  end
  for _,job in ipairs(expired) do
    redis.call('ZREM',leased,job)
    redis.call('HDEL',tokens,job)
    local order = redis.call('HGET',orders,job)
    if order then redis.call('ZADD',ready,order,job) end
  end
  local first = redis.call('ZRANGE',ready,0,0)
  if #first == 0 then return {'empty'} end
  local job = first[1]
  local payload = redis.call('HGET',jobs,job)
  if not payload or #payload > 12000 then return {'damaged'} end
  local untilAt = now + tonumber(ARGV[4]) * 1000
  redis.call('ZREM',ready,job)
  redis.call('ZADD',leased,untilAt,job)
  redis.call('HSET',tokens,job,value)
  touch()
  return {'claimed',job,value,untilAt,payload}
end
if operation ~= 'complete' and operation ~= 'release' then return {'refused'} end
local untilAt = redis.call('ZSCORE',leased,id)
if not untilAt or tonumber(untilAt) <= now or redis.call('HGET',tokens,id) ~= value then
  return {'stale',id}
end
if operation == 'complete' and redis.call('ZCARD',done) >= 1000 then return {'receipts-full'} end
local order = tonumber(redis.call('HGET',orders,id))
if not order then return {'damaged'} end
redis.call('ZREM',leased,id)
redis.call('HDEL',tokens,id)
if operation == 'release' then
  redis.call('ZADD',ready,order,id)
else
  redis.call('HDEL',jobs,id)
  redis.call('HDEL',orders,id)
  redis.call('ZADD',done,now,id)
end
touch()
return {operation,id}
`;
