<Button variant="primary" href="/servers/new">New server</Button>
<Button onClick={stop}>Stop</Button>
<Button variant="destructive" onClick={terminate}>Terminate</Button>

```jsx
Pending state is spelled in the label ("Stopping…"), not with a spinner. Disabled buttons drop to 0.6 opacity.
```
