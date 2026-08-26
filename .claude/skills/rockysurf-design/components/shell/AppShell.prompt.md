Wraps every authenticated screen. Never build a second header.

```jsx
<AppShell title="Servers" current="/" markSrc="../../assets/mark-48.png" onNavigate={go}>
  <div className="server-grid">…</div>
</AppShell>
```
Pass className="page" for the create form's 760px column; the dashboard uses the default 1200px.