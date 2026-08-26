Shown while a server is provisioning, on the detail page and in the create feed.

```jsx
<StepList current="installing_tools" />
<StepList current="cloning_repos" failed />
```
The active step pulses yellow; done steps go green. Put the live install log under it in a <details>.