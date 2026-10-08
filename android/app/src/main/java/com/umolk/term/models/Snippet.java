package com.umolk.term.models;

public class Snippet {
    private String id;
    private String title;
    private String command;
    private String group;

    public Snippet(String id, String title, String command, String group) {
        this.id = id;
        this.title = title;
        this.command = command;
        this.group = (group != null && !group.isEmpty()) ? group : "General";
    }

    public String getId() { return id; }
    public String getTitle() { return title; }
    public String getCommand() { return command; }
    public String getGroup() { return group; }
}
