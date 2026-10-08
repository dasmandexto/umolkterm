package com.umolk.term.models;

public class SshHost {
    private String id;
    private String label;
    private String host;
    private int port;
    private String username;
    private String authType; // "password" or "key"
    private String password;
    private String keyId;
    private String group;
    private boolean isOnline;

    public SshHost(String id, String label, String host, int port, String username, String authType, String password, String keyId, String group) {
        this.id = id;
        this.label = label;
        this.host = host;
        this.port = port;
        this.username = username;
        this.authType = authType;
        this.password = password;
        this.keyId = keyId;
        this.group = group != null && !group.isEmpty() ? group : "Default";
        this.isOnline = false;
    }

    public String getId() { return id; }
    public String getLabel() { return label; }
    public String getHost() { return host; }
    public int getPort() { return port; }
    public String getUsername() { return username; }
    public String getAuthType() { return authType; }
    public String getPassword() { return password; }
    public String getKeyId() { return keyId; }
    public String getGroup() { return group; }
    public boolean isOnline() { return isOnline; }
    public void setOnline(boolean online) { isOnline = online; }

    public String getEndpoint() {
        return username + "@" + host + ":" + port;
    }
}
