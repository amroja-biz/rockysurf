ConfirmModal for any destructive or irreversible action; Modal for a preview or a disclosure.

```jsx
<ConfirmModal title="Terminate dev-box?" message="This destroys the server and its disk. It cannot be undone." confirmLabel="Terminate" isDestructive onCancel={close} onConfirm={go} />
```
The message states the consequence in the user's terms — the disk, the bill — never "are you sure?".