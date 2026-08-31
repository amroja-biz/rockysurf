The dashboard grid item. Put several inside <div className="server-grid">.

```jsx
<ServerCard server={{ name: 'dev-box', status: 'running', publicIp: '203.0.113.10', uptime: '2h 14m', cost: '$0.42' }}
  actions={<><Button>Stop</Button><Button variant="destructive">Terminate</Button></>} />
```
The card border goes blue on hover — the whole card is the link to the detail page.