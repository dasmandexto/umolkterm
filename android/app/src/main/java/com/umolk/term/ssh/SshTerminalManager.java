package com.umolk.term.ssh;

import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.umolk.term.models.SshHost;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class SshTerminalManager {

    public interface SshListener {
        void onConnected();
        void onDataReceived(String data);
        void onError(String error);
        void onDisconnected();
    }

    private JSch jsch;
    private Session session;
    private ChannelShell channel;
    private OutputStream outputStream;
    private InputStream inputStream;
    private ExecutorService executor = Executors.newSingleThreadExecutor();
    private boolean isRunning = false;

    public SshTerminalManager() {
        this.jsch = new JSch();
    }

    public void connect(SshHost host, SshListener listener) {
        executor.execute(() -> {
            try {
                session = jsch.getSession(host.getUsername(), host.getHost(), host.getPort());
                if ("password".equalsIgnoreCase(host.getAuthType()) && host.getPassword() != null) {
                    session.setPassword(host.getPassword());
                }

                Properties config = new Properties();
                config.put("StrictHostKeyChecking", "no");
                session.setConfig(config);
                session.setTimeout(15000);

                session.connect();

                channel = (ChannelShell) session.openChannel("shell");
                channel.setPtyType("xterm-256color");
                
                inputStream = channel.getInputStream();
                outputStream = channel.getOutputStream();

                channel.connect();
                isRunning = true;
                listener.onConnected();

                byte[] buffer = new byte[4096];
                int bytesRead;
                while (isRunning && (bytesRead = inputStream.read(buffer)) != -1) {
                    String data = new String(buffer, 0, bytesRead);
                    listener.onDataReceived(data);
                }

            } catch (Exception e) {
                listener.onError("SSH Error: " + e.getMessage());
            } finally {
                disconnect();
                listener.onDisconnected();
            }
        });
    }

    public void sendData(String data) {
        if (outputStream != null && isRunning) {
            executor.execute(() -> {
                try {
                    outputStream.write(data.getBytes());
                    outputStream.flush();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
        }
    }

    public void disconnect() {
        isRunning = false;
        try {
            if (outputStream != null) outputStream.close();
            if (inputStream != null) inputStream.close();
            if (channel != null) channel.disconnect();
            if (session != null) session.disconnect();
        } catch (Exception ignored) {}
    }
}
