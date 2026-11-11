import asyncio

from test_online_requests import ask, open_up, world


def test_request_cannot_be_accepted_at_expiry(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people['Ada'], people['Bea']
        await open_up(service, hub, ada, bea)
        assert (await ask(service, ada, bea, 'connect4'))['ok']
        request = service.pending_for(bea['id'])[0]
        clock.now = request['expires']
        hub.sent.clear()
        ack = await service.handle(bea, {'t': 'respond', 'id': request['id'], 'accept': True})
        assert not ack['ok']
        assert store.play_request(request['id'])['state'] == 'expired'
        assert store.db.execute('SELECT COUNT(*) FROM rooms WHERE closed = 0').fetchone()[0] == 0
        assert {pid for pid, frame in hub.sent if frame.get('request', {}).get('state') == 'expired'} == {ada['id'], bea['id']}

    asyncio.run(scenario())
